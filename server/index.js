'use strict';

/**
 * index.js — HTTP-слой REST API для связи Roblox Studio и MariaDB.
 *
 * Безопасность и возможности:
 *  - Защита от DoS и спам-запросов (встроенный Rate Limiter)
 *  - Защита от Timing Attacks (constant-time API_KEY check)
 *  - Защита от Prototype Pollution и атак через вложенный JSON
 *  - Защита от переполнения чисел (overflow protection)
 *  - Устойчивость к падению БД: автоматическое фоновое переподключение
 *  - Системы: профили, инвентарь, лидерборды, баны, промокоды, анти-дюп сессий
 */

const express = require('express');

const db = require('./db');
const store = require('./store');
const {
  toInt,
  toNum,
  isUserId,
  normalizeKey,
  normalizeItemKey,
  normalizeCode,
  cleanString,
  readJson,
  isJsonValue,
  safeTimingCompare,
} = require('./util');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = String(process.env.API_KEY || '').trim();
const BODY_LIMIT = process.env.BODY_LIMIT || '128kb';
const MAX_BATCH_OPS = 100;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 300; // макс. запросов в минуту с одного IP
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ------------------------------------------------------------------
//  Вспомогательные функции для ответов
// ------------------------------------------------------------------

const ok = (res, payload = {}) => res.json({ ok: true, ...payload });
const fail = (res, code, message, extra = {}) =>
  res.status(code).json({ ok: false, error: message, ...extra });

function readUserId(source) {
  if (!source || typeof source !== 'object') return null;
  const userId = toInt(source.userId, -1);
  return isUserId(userId) ? userId : null;
}

function readPaging(query, defLimit = 25, maxLimit = 100) {
  const limit = Math.min(Math.max(toInt(query.limit, defLimit), 1), maxLimit);
  const offset = Math.max(toInt(query.offset, 0), 0);
  return { limit, offset };
}

function readTarget(source) {
  const userId = readUserId(source);
  if (userId === null) return { error: 'userId должен быть положительным целым числом Roblox' };

  const key = normalizeKey(source.key);
  if (key === null) {
    return {
      error:
        'key должен быть корректным именем поля (например: coins, level, xp или pets.dragon.level)',
    };
  }
  return { userId, key };
}

function readUsername(body) {
  return cleanString(body?.username, 64);
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

// ------------------------------------------------------------------
//  Настройка Express и Middleware безопасности
// ------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

// Заголовки безопасности
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// JSON парсер с ограничением размера тела
app.use(express.json({ limit: BODY_LIMIT }));

// Встроенный In-Memory Rate Limiter по IP (защита от DoS и спам-запросов)
const rateLimits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits.entries()) {
    if (now - entry.startTime > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();

  const ip = getClientIp(req);
  const now = Date.now();
  let entry = rateLimits.get(ip);

  if (!entry || now - entry.startTime > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 1, startTime: now };
    rateLimits.set(ip, entry);
  } else {
    entry.count += 1;
    if (entry.count > RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', '60');
      return fail(
        res,
        429,
        `Превышен лимит запросов (${RATE_LIMIT_MAX} в минуту). Попробуйте позже.`
      );
    }
  }
  next();
});

// Авторизация по API_KEY (Timing-Safe)
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.path === '/health' || req.path === '/') return next();

  const provided = String(req.get('x-api-key') || req.query.api_key || '');
  if (!safeTimingCompare(provided, API_KEY)) {
    return fail(res, 401, 'Неверный или отсутствующий x-api-key заголовок');
  }
  return next();
});

// Проверка доступности базы данных для всех рабочих эндпоинтов
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();
  if (!db.isReady()) {
    return fail(
      res,
      503,
      'База данных MariaDB в данный момент недоступна. Убедитесь, что служба MariaDB запущена на порту 3306.'
    );
  }
  next();
});

// ==================================================================
//  Служебные эндпоинты
// ==================================================================

app.get('/', (_req, res) =>
  ok(res, {
    service: 'roblox-mariadb-bridge',
    version: '3.0.0',
    status: db.isReady() ? 'online' : 'database_connecting',
    auth: API_KEY ? 'x-api-key обязателен' : 'не требуется',
    endpoints: {
      'GET  /health': 'проверка состояния сервера и MariaDB',
      'GET  /player?userId=': 'полный профиль игрока',
      'POST /player': 'создать/обновить профиль (coins, gems, level, xp, data)',
      'POST /player/delete': 'удалить игрока целиком',
      'GET  /players?search=&limit=': 'поиск по нику',
      'GET  /stat?userId=&key=': 'получить одно поле (coins, gems, level, xp, json)',
      'POST /set': 'глубокое слияние data: {...}',
      'POST /set-stat': 'записать одно поле {userId, key, value}',
      'POST /add-stat': 'атомарно прибавить к полю {userId, key, delta}',
      'GET  /leaderboard?key=&limit=&order=': 'таблица лидеров',
      'GET  /items?userId=': 'инвентарь игрока',
      'POST /items/add': 'изменить количество предмета {userId, itemKey, amount}',
      'POST /items/set': 'задать количество предмета {userId, itemKey, amount, meta}',
      'POST /player/ban': 'заблокировать игрока {userId, reason}',
      'POST /player/unban': 'разблокировать игрока {userId}',
      'GET  /player/ban?userId=': 'проверить статус блокировки игрока',
      'POST /code/create': 'создать промокод',
      'POST /code/redeem': 'активировать промокод {userId, code}',
      'GET  /code/list': 'список активных промокодов',
      'POST /session/acquire': 'захватить сессию (защита от дюпов)',
      'POST /session/release': 'освободить сессию',
      'POST /batch': 'пачка атомарных операций в транзакции',
      'GET  /admin/stats': 'сводная статистика базы и экономики',
    },
  })
);

app.get('/health', async (_req, res) => {
  if (!db.isReady()) {
    return fail(res, 503, 'MariaDB недоступна', {
      status: 'database_down',
      hint: 'Проверьте, запущена ли служба MariaDB/MySQL на порту 3306 и правильны ли данные в server/.env',
    });
  }
  try {
    const startTime = Date.now();
    await db.query('SELECT 1');
    const latencyMs = Date.now() - startTime;
    const [{ total }] = await db.query('SELECT COUNT(*) AS total FROM player_stats');
    ok(res, {
      status: 'up',
      database: db.CONFIG.database,
      latencyMs,
      players: Number(total),
      time: new Date().toISOString(),
    });
  } catch (err) {
    fail(res, 503, 'Ошибка обращения к базе данных', { detail: db.describeError(err) });
  }
});

// ==================================================================
//  Профиль игрока
// ==================================================================

app.get('/player', async (req, res) => {
  const userId = readUserId(req.query);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  try {
    const profile = await store.getProfile(db, userId);
    if (!profile) {
      return ok(res, {
        found: false,
        userId,
        username: '',
        coins: 0,
        gems: 0,
        level: 1,
        xp: 0,
        data: {},
        is_banned: false,
        items: [],
      });
    }
    const items = await store.listItems(db, userId);
    return ok(res, { found: true, ...profile, items });
  } catch (err) {
    console.error('[GET /player]', err.message);
    return fail(res, 500, 'Не удалось прочитать профиль', { detail: db.describeError(err) });
  }
});

app.get('/get-data', (req, res) => res.redirect(307, `/player?${new URLSearchParams(req.query)}`));

app.post('/player', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  const coins =
    body.coins === undefined || body.coins === null ? null : Math.max(0, toNum(body.coins, 0));
  const gems =
    body.gems === undefined || body.gems === null ? null : Math.max(0, toNum(body.gems, 0));
  const level =
    body.level === undefined || body.level === null ? null : Math.max(1, toInt(body.level, 1));
  const xp =
    body.xp === undefined || body.xp === null ? null : Math.max(0, toInt(body.xp, 0));
  const data = readJson(body.data);
  const expectedVersion =
    body.expectedVersion !== undefined ? toInt(body.expectedVersion, null) : null;
  const playtimeDelta = Math.max(0, toInt(body.playtimeDelta, 0));

  try {
    const result = await store.upsertProfile(db, {
      userId,
      username: readUsername(body),
      coins,
      gems,
      level,
      xp,
      data,
      expectedVersion,
      playtimeDelta,
      ip: getClientIp(req),
    });

    if (result.conflict) {
      return fail(res, 409, result.message, { currentVersion: result.currentVersion });
    }

    const profile = await store.getProfile(db, userId);
    return ok(res, { saved: true, player: profile });
  } catch (err) {
    console.error('[POST /player]', err.message);
    return fail(res, 500, 'Не удалось сохранить профиль', { detail: db.describeError(err) });
  }
});

app.post('/save-data', (req, res) => res.redirect(307, '/player'));

app.post('/player/delete', async (req, res) => {
  const userId = readUserId(req.body || {});
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  try {
    const removed = await db.transaction((tx) => store.deletePlayer(tx, userId));
    return ok(res, { deleted: true, userId, removed });
  } catch (err) {
    console.error('[POST /player/delete]', err.message);
    return fail(res, 500, 'Не удалось удалить игрока', { detail: db.describeError(err) });
  }
});

app.get('/players', async (req, res) => {
  const search = cleanString(req.query.search, 64);
  if (search.length < 1) return fail(res, 400, 'Параметр search обязателен (минимум 1 символ)');

  const { limit, offset } = readPaging(req.query, 25, 100);
  const exact = String(req.query.exact).toLowerCase() === 'true';

  try {
    const players = await store.searchPlayers(db, search, limit, offset, exact);
    return ok(res, { search, exact, limit, offset, count: players.length, players });
  } catch (err) {
    console.error('[GET /players]', err.message);
    return fail(res, 500, 'Ошибка поиска игроков', { detail: db.describeError(err) });
  }
});

// ==================================================================
//  Поля статистики
// ==================================================================

app.get('/stat', async (req, res) => {
  const target = readTarget(req.query);
  if (target.error) return fail(res, 400, target.error);

  try {
    const result = await store.getStat(db, target.userId, target.key);
    return ok(res, {
      found: result.found,
      userId: target.userId,
      username: result.username,
      key: target.key,
      value: result.found
        ? result.value
        : target.key === 'coins' || target.key === 'gems'
        ? 0
        : null,
    });
  } catch (err) {
    console.error('[GET /stat]', err.message);
    return fail(res, 500, 'Не удалось прочитать поле', { detail: db.describeError(err) });
  }
});

app.get('/get-stat', (req, res) => res.redirect(307, `/stat?${new URLSearchParams(req.query)}`));

app.post('/set', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  const data = readJson(body.data);
  if (data === null) return fail(res, 400, 'data должен быть валидным JSON-объектом');

  const coins =
    body.coins === undefined || body.coins === null ? null : Math.max(0, toNum(body.coins, 0));
  const gems =
    body.gems === undefined || body.gems === null ? null : Math.max(0, toNum(body.gems, 0));

  try {
    await store.upsertProfile(db, {
      userId,
      username: readUsername(body),
      coins,
      gems,
      data,
      ip: getClientIp(req),
    });
    await db.writeLog(userId, 'set', { data, coins, gems }, getClientIp(req));
    const profile = await store.getProfile(db, userId);
    return ok(res, {
      saved: true,
      data: profile?.data ?? {},
      coins: profile?.coins ?? 0,
      gems: profile?.gems ?? 0,
    });
  } catch (err) {
    console.error('[POST /set]', err.message);
    return fail(res, 500, 'Не удалось сохранить данные', { detail: db.describeError(err) });
  }
});

app.post('/set-stat', async (req, res) => {
  const body = req.body || {};
  const target = readTarget(body);
  if (target.error) return fail(res, 400, target.error);

  if (!isJsonValue(body.value) && typeof body.value !== 'object') {
    return fail(
      res,
      400,
      'value должно быть числом, строкой, булевым значением, null или JSON-объектом'
    );
  }

  try {
    await store.setStat(db, target.userId, target.key, body.value, readUsername(body));
    await db.writeLog(
      target.userId,
      'set-stat',
      { key: target.key, value: body.value },
      getClientIp(req)
    );
    const result = await store.getStat(db, target.userId, target.key);
    return ok(res, { userId: target.userId, key: target.key, value: result.value });
  } catch (err) {
    console.error('[POST /set-stat]', err.message);
    return fail(res, 500, 'Не удалось записать поле', { detail: db.describeError(err) });
  }
});

app.post('/add-stat', async (req, res) => {
  const body = req.body || {};
  const target = readTarget(body);
  if (target.error) return fail(res, 400, target.error);

  const delta = toNum(body.delta, NaN);
  if (!Number.isFinite(delta)) return fail(res, 400, 'delta должен быть числом');

  try {
    await store.addStat(db, target.userId, target.key, delta, readUsername(body));
    await db.writeLog(
      target.userId,
      'add-stat',
      { key: target.key, delta },
      getClientIp(req)
    );
    const result = await store.getStat(db, target.userId, target.key);
    return ok(res, { userId: target.userId, key: target.key, delta, value: result.value });
  } catch (err) {
    console.error('[POST /add-stat]', err.message);
    return fail(res, 500, 'Не удалось прибавить к полю', { detail: db.describeError(err) });
  }
});

// ==================================================================
//  Таблица лидеров
// ==================================================================

app.get('/leaderboard', async (req, res) => {
  const key = normalizeKey(req.query.key) ?? store.COIN_KEY;
  const { limit, offset } = readPaging(req.query, 25, 100);
  const desc = String(req.query.order ?? 'desc').toLowerCase() !== 'asc';

  try {
    const rows = await store.leaderboard(db, key, limit, offset, desc);
    const position = offset + 1;
    return ok(res, {
      key,
      limit,
      offset,
      order: desc ? 'desc' : 'asc',
      count: rows.length,
      players: rows.map((row, i) => ({ ...row, position: position + i })),
    });
  } catch (err) {
    console.error('[GET /leaderboard]', err.message);
    return fail(res, 500, 'Не удалось получить таблицу лидеров', {
      detail: db.describeError(err),
    });
  }
});

// ==================================================================
//  Инвентарь
// ==================================================================

app.get('/items', async (req, res) => {
  const userId = readUserId(req.query);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  try {
    return ok(res, { userId, items: await store.listItems(db, userId) });
  } catch (err) {
    console.error('[GET /items]', err.message);
    return fail(res, 500, 'Не удалось прочитать инвентарь', { detail: db.describeError(err) });
  }
});

app.get('/items/get', async (req, res) => {
  const userId = readUserId(req.query);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const itemKey = normalizeItemKey(req.query.itemKey);
  if (itemKey === null) return fail(res, 400, 'itemKey обязателен (буквы, цифры, _, ., -)');

  try {
    return ok(res, {
      userId,
      itemKey,
      amount: await store.getItemAmount(db, userId, itemKey),
    });
  } catch (err) {
    console.error('[GET /items/get]', err.message);
    return fail(res, 500, 'Не удалось прочитать количество предмета', {
      detail: db.describeError(err),
    });
  }
});

app.get('/items/totals', async (req, res) => {
  const itemKey = normalizeItemKey(req.query.itemKey);
  if (itemKey === null) return fail(res, 400, 'itemKey обязателен');

  try {
    return ok(res, { ...(await store.itemTotals(db, itemKey)) });
  } catch (err) {
    console.error('[GET /items/totals]', err.message);
    return fail(res, 500, 'Не удалось получить сводку по предмету', {
      detail: db.describeError(err),
    });
  }
});

app.post('/items/add', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const itemKey = normalizeItemKey(body.itemKey);
  if (itemKey === null) return fail(res, 400, 'itemKey обязателен (буквы, цифры, _, ., -)');

  const amount = toInt(body.amount, 0);
  if (amount === 0) return fail(res, 400, 'amount должен быть ненулевым целым числом');

  try {
    await store.addItem(db, userId, itemKey, amount);
    await db.writeLog(userId, 'items/add', { itemKey, amount }, getClientIp(req));
    return ok(res, {
      userId,
      itemKey,
      amount: await store.getItemAmount(db, userId, itemKey),
    });
  } catch (err) {
    console.error('[POST /items/add]', err.message);
    return fail(res, 500, 'Не удалось изменить количество предмета', {
      detail: db.describeError(err),
    });
  }
});

app.post('/items/set', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const itemKey = normalizeItemKey(body.itemKey);
  if (itemKey === null) return fail(res, 400, 'itemKey обязателен (буквы, цифры, _, ., -)');

  const meta = readJson(body.meta);

  try {
    await store.setItem(db, userId, itemKey, body.amount, meta);
    await db.writeLog(
      userId,
      'items/set',
      { itemKey, amount: body.amount, meta },
      getClientIp(req)
    );
    return ok(res, {
      userId,
      itemKey,
      amount: await store.getItemAmount(db, userId, itemKey),
    });
  } catch (err) {
    console.error('[POST /items/set]', err.message);
    return fail(res, 500, 'Не удалось задать количество предмета', {
      detail: db.describeError(err),
    });
  }
});

// ==================================================================
//  Блокировки (Баны)
// ==================================================================

app.post('/player/ban', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  const reason = cleanString(body.reason, 255) || 'Нарушение правил';

  try {
    await store.banPlayer(db, userId, reason);
    await db.writeLog(userId, 'ban', { reason }, getClientIp(req));
    return ok(res, { banned: true, userId, reason });
  } catch (err) {
    console.error('[POST /player/ban]', err.message);
    return fail(res, 500, 'Не удалось заблокировать игрока', { detail: db.describeError(err) });
  }
});

app.post('/player/unban', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  try {
    await store.unbanPlayer(db, userId);
    await db.writeLog(userId, 'unban', {}, getClientIp(req));
    return ok(res, { unbanned: true, userId });
  } catch (err) {
    console.error('[POST /player/unban]', err.message);
    return fail(res, 500, 'Не удалось разблокировать игрока', { detail: db.describeError(err) });
  }
});

app.get('/player/ban', async (req, res) => {
  const userId = readUserId(req.query);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  try {
    const status = await store.getBanStatus(db, userId);
    return ok(res, status);
  } catch (err) {
    console.error('[GET /player/ban]', err.message);
    return fail(res, 500, 'Ошибка проверки статуса бана', { detail: db.describeError(err) });
  }
});

// ==================================================================
//  Промокоды
// ==================================================================

app.post('/code/create', async (req, res) => {
  const body = req.body || {};
  const code = normalizeCode(body.code);
  if (!code) return fail(res, 400, 'code должен содержать от 3 до 32 символов (буквы, цифры, _, -)');

  const rewardCoins = Math.max(0, toNum(body.rewardCoins, 0));
  const rewardGems = Math.max(0, toNum(body.rewardGems, 0));
  const rewardItem = normalizeItemKey(body.rewardItem) || null;
  const rewardAmount = Math.max(0, toInt(body.rewardAmount, 0));
  const maxUses = Math.max(0, toInt(body.maxUses, 0));
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

  try {
    await store.createPromoCode(db, {
      code,
      rewardCoins,
      rewardGems,
      rewardItem,
      rewardAmount,
      maxUses,
      expiresAt,
    });
    return ok(res, { created: true, code });
  } catch (err) {
    console.error('[POST /code/create]', err.message);
    return fail(res, 500, 'Не удалось создать промокод', { detail: db.describeError(err) });
  }
});

app.post('/code/redeem', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const code = normalizeCode(body.code);
  if (!code) return fail(res, 400, 'Некорректный промокод');

  try {
    const result = await store.redeemPromoCode(db, userId, code);
    if (!result.ok) {
      return fail(res, 400, result.error);
    }
    return ok(res, { redeemed: true, code, rewards: result.rewards });
  } catch (err) {
    console.error('[POST /code/redeem]', err.message);
    return fail(res, 500, 'Ошибка активации промокода', { detail: db.describeError(err) });
  }
});

app.get('/code/list', async (_req, res) => {
  try {
    const codes = await store.listPromoCodes(db);
    return ok(res, { count: codes.length, codes });
  } catch (err) {
    console.error('[GET /code/list]', err.message);
    return fail(res, 500, 'Не удалось получить список промокодов', {
      detail: db.describeError(err),
    });
  }
});

// ==================================================================
//  Session Locking (Защита от дублирования между серверами)
// ==================================================================

app.post('/session/acquire', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const jobId = cleanString(body.jobId, 128);
  if (!jobId) return fail(res, 400, 'jobId обязателен');
  const placeId = toInt(body.placeId, 0);

  try {
    const result = await store.acquireSession(db, userId, jobId, placeId, getClientIp(req));
    if (!result.acquired) {
      return fail(res, 409, result.message);
    }
    return ok(res, { acquired: true, userId, jobId });
  } catch (err) {
    console.error('[POST /session/acquire]', err.message);
    return fail(res, 500, 'Ошибка захвата сессии', { detail: db.describeError(err) });
  }
});

app.post('/session/release', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const jobId = cleanString(body.jobId, 128);

  try {
    await store.releaseSession(db, userId, jobId);
    return ok(res, { released: true, userId });
  } catch (err) {
    console.error('[POST /session/release]', err.message);
    return fail(res, 500, 'Ошибка освобождения сессии', { detail: db.describeError(err) });
  }
});

app.post('/session/heartbeat', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const jobId = cleanString(body.jobId, 128);

  try {
    await store.heartbeatSession(db, userId, jobId);
    return ok(res, { heartbeat: true });
  } catch (err) {
    console.error('[POST /session/heartbeat]', err.message);
    return fail(res, 500, 'Ошибка heartbeat', { detail: db.describeError(err) });
  }
});

// ==================================================================
//  Журнал аудита
// ==================================================================

app.get('/log', async (req, res) => {
  const userId = readUserId(req.query);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');
  const { limit } = readPaging(req.query, 50, 200);

  try {
    return ok(res, { userId, limit, entries: await store.readLog(db, userId, limit) });
  } catch (err) {
    console.error('[GET /log]', err.message);
    return fail(res, 500, 'Не удалось прочитать журнал', { detail: db.describeError(err) });
  }
});

app.post('/log', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  const action = cleanString(body.action, 64);
  if (!action) return fail(res, 400, 'action обязателен');

  try {
    await db.writeLog(userId, action, readJson(body.payload), getClientIp(req));
    return ok(res, {
      logged: String(process.env.LOG_ENABLED).toLowerCase() === 'true',
      action,
    });
  } catch (err) {
    console.error('[POST /log]', err.message);
    return fail(res, 500, 'Не удалось записать в журнал', { detail: db.describeError(err) });
  }
});

// ==================================================================
//  Статистика экономики и администрирование
// ==================================================================

app.get('/admin/stats', async (_req, res) => {
  try {
    const stats = await store.getEconomyStats(db);
    return ok(res, stats);
  } catch (err) {
    console.error('[GET /admin/stats]', err.message);
    return fail(res, 500, 'Не удалось получить статистику', { detail: db.describeError(err) });
  }
});

// ==================================================================
//  Пачка операций (POST /batch)
// ==================================================================

app.post('/batch', async (req, res) => {
  const body = req.body || {};
  const userId = readUserId(body);
  if (userId === null) return fail(res, 400, 'userId должен быть положительным целым числом');

  const ops = Array.isArray(body.ops) ? body.ops : null;
  if (!ops) return fail(res, 400, 'ops должен быть массивом операций');
  if (ops.length === 0) return fail(res, 400, 'ops не может быть пустым');
  if (ops.length > MAX_BATCH_OPS)
    return fail(res, 400, `Не больше ${MAX_BATCH_OPS} операций за один запрос`);

  const username = readUsername(body);

  const plan = [];
  for (const [index, raw] of ops.entries()) {
    const op = raw && typeof raw === 'object' ? raw : {};
    const kind = cleanString(op.op, 32);

    try {
      switch (kind) {
        case 'add':
        case 'set': {
          const key = normalizeKey(op.key);
          if (key === null) throw new Error(`ops[${index}]: неверный key`);
          if (kind === 'add') {
            const delta = Number(op.delta);
            if (!Number.isFinite(delta)) throw new Error(`ops[${index}]: delta должен быть числом`);
            plan.push((tx) => store.addStat(tx, userId, key, delta, username));
          } else {
            if (op.value === undefined) throw new Error(`ops[${index}]: нужен value`);
            plan.push((tx) => store.setStat(tx, userId, key, op.value, username));
          }
          break;
        }
        case 'profile': {
          const data = op.data === undefined ? null : readJson(op.data);
          const coins =
            op.coins === undefined || op.coins === null ? null : Math.max(0, toNum(op.coins, 0));
          const gems =
            op.gems === undefined || op.gems === null ? null : Math.max(0, toNum(op.gems, 0));
          const level =
            op.level === undefined || op.level === null ? null : Math.max(1, toInt(op.level, 1));
          const xp =
            op.xp === undefined || op.xp === null ? null : Math.max(0, toInt(op.xp, 0));
          const name = cleanString(op.username, 64) || username;
          plan.push((tx) =>
            store.upsertProfile(tx, {
              userId,
              username: name,
              coins,
              gems,
              level,
              xp,
              data,
              ip: getClientIp(req),
            })
          );
          break;
        }
        case 'itemsAdd': {
          const itemKey = normalizeItemKey(op.itemKey);
          if (itemKey === null) throw new Error(`ops[${index}]: неверный itemKey`);
          const amount = toInt(op.amount, 0);
          if (amount === 0) throw new Error(`ops[${index}]: amount должен быть ненулевым целым`);
          plan.push((tx) => store.addItem(tx, userId, itemKey, amount));
          break;
        }
        case 'itemsSet': {
          const itemKey = normalizeItemKey(op.itemKey);
          if (itemKey === null) throw new Error(`ops[${index}]: неверный itemKey`);
          const meta = op.meta === undefined ? null : readJson(op.meta);
          plan.push((tx) => store.setItem(tx, userId, itemKey, op.amount, meta));
          break;
        }
        case 'log': {
          const action = cleanString(op.action, 64);
          if (!action) throw new Error(`ops[${index}]: нужен action`);
          plan.push((tx) => db.writeLog(userId, action, readJson(op.payload), getClientIp(req), tx));
          break;
        }
        default:
          throw new Error(`ops[${index}]: неизвестная операция "${kind}"`);
      }
    } catch (err) {
      return fail(res, 400, err.message);
    }
  }

  try {
    await db.transaction(async (tx) => {
      for (const step of plan) await step(tx);
    });
    const profile = await store.getProfile(db, userId);
    const items = await store.listItems(db, userId);
    return ok(res, { applied: ops.length, player: profile, items });
  } catch (err) {
    console.error('[POST /batch]', err.message);
    return fail(res, 500, 'Транзакция пачки операций откачена из-за ошибки', {
      detail: db.describeError(err),
    });
  }
});

// ==================================================================
//  Обработка ошибок и запуск
// ==================================================================

app.use((_req, res) => fail(res, 404, 'Неизвестный эндпоинт. Список доступных: GET /'));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Тело запроса — невалидный JSON');
  if (err.type === 'entity.too.large')
    return fail(res, 413, `Слишком большое тело запроса (лимит ${BODY_LIMIT})`);
  console.error('[unhandled error]', err);
  return fail(res, 500, 'Внутренняя ошибка сервера');
});

// Запуск HTTP-сервера с фоновым подключением к MariaDB
(async () => {
  app.listen(PORT, () => {
    console.log(`[http] HTTP Сервер запущен: http://localhost:${PORT}`);
    console.log(`[http] Документация API: GET http://localhost:${PORT}/`);
    console.log(`[http] Авторизация: ${API_KEY ? 'требуется x-api-key' : 'не требуется'}`);
    console.log(
      `[http] Аудит player_log: ${
        String(process.env.LOG_ENABLED).toLowerCase() === 'true' ? 'включён' : 'выключен'
      }`
    );
  });

  // Функция попытки подключения к MariaDB с авто-повторами
  async function attemptDbConnect() {
    try {
      await db.init();
    } catch (err) {
      console.warn(`[db] MariaDB пока недоступна (${db.describeError(err)}).`);
      console.warn('     Повторная попытка через 5 секунд... Запусти службу MariaDB, когда будешь готов.');
      setTimeout(attemptDbConnect, 5000);
    }
  }

  attemptDbConnect();
})();