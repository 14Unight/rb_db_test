'use strict';

/**
 * store.js — Логика хранения данных игроков, инвентаря, промокодов и блокировок.
 *
 * Все запросы строго параметризованы (Prepared Statements).
 * Поддерживает:
 *  - Отдельные индексированные колонки: coins, gems, level, xp
 *  - Произвольные вложенные JSON-поля в data (например: pets.dragon.level)
 *  - Атомарные транзакции и оптимистическую блокировку версий
 *  - Инвентарь с метаданными и валидацией
 *  - Систему банов и разбанов
 *  - Систему промокодов с защитой от повторной активации
 *  - Session Locking для защиты от дюпов предметов между серверами
 */

const db = require('./db');
const { jsonPath, MAX_SAFE_INT } = require('./util');

/** Ключи, вынесенные в отдельные индексированные колонки таблицы */
const DEDICATED_KEYS = new Set(['coins', 'gems', 'level', 'xp']);
const COIN_KEY = 'coins';

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readPath(source, key) {
  let current = source;
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function writePath(target, key, value) {
  const parts = key.split('.');
  let current = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof current[part] !== 'object' || current[part] === null || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return target;
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// ==================================================================
//  1. Профиль игрока
// ==================================================================

/**
 * Возвращает полный профиль игрока со всеми полями, инвентарём и статусом бана.
 */
async function getProfile(ex, userId) {
  const row = await ex.queryOne(
    `SELECT userId, username, coins, gems, level, xp, data,
            is_banned, ban_reason, save_version, playtime_seconds,
            last_ip, last_login, created_at, updated_at
     FROM player_stats WHERE userId = ? LIMIT 1`,
    [userId]
  );
  if (!row) return null;

  return {
    userId: Number(row.userId),
    username: row.username,
    coins: Number(row.coins),
    gems: Number(row.gems || 0),
    level: Number(row.level || 1),
    xp: Number(row.xp || 0),
    data: parseJsonColumn(row.data) ?? {},
    is_banned: Boolean(row.is_banned),
    ban_reason: row.ban_reason || null,
    save_version: Number(row.save_version || 1),
    playtime_seconds: Number(row.playtime_seconds || 0),
    last_ip: row.last_ip || null,
    last_login: toIso(row.last_login),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/**
 * Создаёт или обновляет профиль.
 * Поддерживает глубокое слияние JSON (data), контроль версий и обновление валют.
 */
async function upsertProfile(
  ex,
  {
    userId,
    username = '',
    coins = null,
    gems = null,
    level = null,
    xp = null,
    data = null,
    expectedVersion = null,
    playtimeDelta = 0,
    ip = null,
  }
) {
  // Оптимистическая блокировка (проверка конфликта версий при сохранении)
  if (expectedVersion !== null && expectedVersion !== undefined) {
    const current = await ex.queryOne(
      'SELECT save_version FROM player_stats WHERE userId = ? LIMIT 1',
      [userId]
    );
    if (current && Number(current.save_version) !== Number(expectedVersion)) {
      return {
        conflict: true,
        currentVersion: Number(current.save_version),
        message: 'Версия данных устарела. Возможно, сохранение произошло из другого места.',
      };
    }
  }

  const columns = ['userId'];
  const values = [userId];
  const updates = [];

  if (username) {
    columns.push('username');
    values.push(username);
    updates.push('username = VALUES(username)');
  }
  if (coins !== null) {
    const safeCoins = Math.min(Math.max(0, Number(coins) || 0), MAX_SAFE_INT);
    columns.push('coins');
    values.push(safeCoins);
    updates.push('coins = VALUES(coins)');
  }
  if (gems !== null) {
    const safeGems = Math.min(Math.max(0, Number(gems) || 0), MAX_SAFE_INT);
    columns.push('gems');
    values.push(safeGems);
    updates.push('gems = VALUES(gems)');
  }
  if (level !== null) {
    const safeLevel = Math.max(1, Math.trunc(Number(level) || 1));
    columns.push('level');
    values.push(safeLevel);
    updates.push('level = VALUES(level)');
  }
  if (xp !== null) {
    const safeXp = Math.min(Math.max(0, Math.trunc(Number(xp) || 0)), MAX_SAFE_INT);
    columns.push('xp');
    values.push(safeXp);
    updates.push('xp = VALUES(xp)');
  }
  if (data !== null) {
    columns.push('data');
    values.push(JSON.stringify(data));
    updates.push("data = JSON_MERGE_PATCH(COALESCE(player_stats.data, '{}'), VALUES(data))");
  }
  if (ip) {
    columns.push('last_ip');
    values.push(ip);
    updates.push('last_ip = VALUES(last_ip)');
  }

  // Обновляем время игры и версию
  const pDelta = Math.max(0, Math.trunc(Number(playtimeDelta) || 0));
  updates.push(`playtime_seconds = playtime_seconds + ${pDelta}`);
  updates.push('save_version = save_version + 1');
  updates.push('last_login = CURRENT_TIMESTAMP');

  if (columns.length === 1) {
    columns.push('username');
    values.push('');
  }

  const sql = `INSERT INTO player_stats (${columns.join(', ')})
               VALUES (${columns.map(() => '?').join(', ')})
               ON DUPLICATE KEY UPDATE ${updates.join(', ')}`;

  await ex.execute(sql, values);
  return { conflict: false };
}

/**
 * Удаляет игрока целиком со всеми связанными данными.
 */
async function deletePlayer(ex, userId) {
  const profile = await ex.execute('DELETE FROM player_stats WHERE userId = ?', [userId]);
  const items = await ex.execute('DELETE FROM player_items WHERE userId = ?', [userId]);
  const log = await ex.execute('DELETE FROM player_log WHERE userId = ?', [userId]);
  const sessions = await ex.execute('DELETE FROM active_sessions WHERE userId = ?', [userId]);
  const redemptions = await ex.execute('DELETE FROM code_redemptions WHERE userId = ?', [userId]);

  return {
    profile: profile.affectedRows,
    items: items.affectedRows,
    log: log.affectedRows,
    sessions: sessions.affectedRows,
    redemptions: redemptions.affectedRows,
  };
}

/**
 * Поиск игроков по нику с безопасной пагинацией.
 */
async function searchPlayers(ex, search, limit, offset, exact) {
  const pattern = `%${search}%`;
  const like = exact ? search : pattern;
  const rows = await ex.query(
    `SELECT userId, username, coins, gems, level, is_banned, updated_at
     FROM player_stats
     WHERE username LIKE ?
     ORDER BY username ASC
     LIMIT ? OFFSET ?`,
    [like, limit, offset]
  );
  return rows.map((row) => ({
    userId: Number(row.userId),
    username: row.username,
    coins: Number(row.coins),
    gems: Number(row.gems || 0),
    level: Number(row.level || 1),
    is_banned: Boolean(row.is_banned),
    updated_at: toIso(row.updated_at),
  }));
}

// ==================================================================
//  2. Универсальные поля (getStat, setStat, addStat)
// ==================================================================

async function getStat(ex, userId, key) {
  const row = await ex.queryOne(
    `SELECT username, coins, gems, level, xp, data
     FROM player_stats WHERE userId = ? LIMIT 1`,
    [userId]
  );
  if (!row) return { found: false, username: '', value: null };

  if (key === 'coins') return { found: true, username: row.username, value: Number(row.coins) };
  if (key === 'gems') return { found: true, username: row.username, value: Number(row.gems || 0) };
  if (key === 'level') return { found: true, username: row.username, value: Number(row.level || 1) };
  if (key === 'xp') return { found: true, username: row.username, value: Number(row.xp || 0) };

  const data = parseJsonColumn(row.data) ?? {};
  const val = readPath(data, key);
  const found = val !== undefined;

  return {
    found,
    username: row.username,
    value: found ? val : null,
  };
}

async function setStat(ex, userId, key, value, username = '') {
  // Выделенные индексированные колонки
  if (key === 'coins' || key === 'gems') {
    const safeVal = Math.min(Math.max(0, Math.trunc(Number(value) || 0)), MAX_SAFE_INT);
    return ex.execute(
      `INSERT INTO player_stats (userId, username, \`${key}\`) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         \`${key}\` = VALUES(\`${key}\`)`,
      [userId, username, safeVal]
    );
  }

  if (key === 'level') {
    const safeVal = Math.max(1, Math.trunc(Number(value) || 1));
    return ex.execute(
      `INSERT INTO player_stats (userId, username, level) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         level = VALUES(level)`,
      [userId, username, safeVal]
    );
  }

  if (key === 'xp') {
    const safeVal = Math.min(Math.max(0, Math.trunc(Number(value) || 0)), MAX_SAFE_INT);
    return ex.execute(
      `INSERT INTO player_stats (userId, username, xp) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         xp = VALUES(xp)`,
      [userId, username, safeVal]
    );
  }

  // Обычный ключ без точки
  if (!key.includes('.')) {
    return ex.execute(
      `INSERT INTO player_stats (userId, username, data)
       VALUES (?, ?, JSON_SET('{}', ?, JSON_EXTRACT(?, '$')))
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         data = JSON_SET(COALESCE(player_stats.data, '{}'), ?, JSON_EXTRACT(?, '$'))`,
      [userId, username, jsonPath(key), JSON.stringify(value), jsonPath(key), JSON.stringify(value)]
    );
  }

  // Вложенный ключ
  const apply = async (tx) => {
    const row = await tx.queryOne(
      'SELECT data FROM player_stats WHERE userId = ? FOR UPDATE',
      [userId]
    );
    const data = parseJsonColumn(row?.data) ?? {};
    writePath(data, key, value);
    await tx.execute(
      `INSERT INTO player_stats (userId, username, data) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         data = VALUES(data)`,
      [userId, username, JSON.stringify(data)]
    );
    return { affectedRows: 1 };
  };

  return ex.inTransaction ? apply(ex) : db.transaction(apply);
}

async function addStat(ex, userId, key, delta, username = '') {
  const amount = Number(delta) || 0;

  if (key === 'coins' || key === 'gems') {
    return ex.execute(
      `INSERT INTO player_stats (userId, username, \`${key}\`) VALUES (?, ?, GREATEST(0, ?))
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         \`${key}\` = GREATEST(0, \`${key}\` + ?)`,
      [userId, username, amount, amount]
    );
  }

  if (key === 'level') {
    const dInt = Math.trunc(amount);
    return ex.execute(
      `INSERT INTO player_stats (userId, username, level) VALUES (?, ?, GREATEST(1, ?))
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         level = GREATEST(1, level + ?)`,
      [userId, username, dInt, dInt]
    );
  }

  if (key === 'xp') {
    const dInt = Math.trunc(amount);
    return ex.execute(
      `INSERT INTO player_stats (userId, username, xp) VALUES (?, ?, GREATEST(0, ?))
       ON DUPLICATE KEY UPDATE
         username = IF(VALUES(username) = '', username, VALUES(username)),
         xp = GREATEST(0, xp + ?)`,
      [userId, username, dInt, dInt]
    );
  }

  // Добавление в JSON-поле
  const path = jsonPath(key);
  return ex.execute(
    `INSERT INTO player_stats (userId, username, data)
     VALUES (?, ?, JSON_SET('{}', ?, CAST(? AS DECIMAL(20,4))))
     ON DUPLICATE KEY UPDATE
       username = IF(VALUES(username) = '', username, VALUES(username)),
       data = JSON_SET(
         COALESCE(player_stats.data, '{}'),
         ?,
         COALESCE(
           CAST(JSON_UNQUOTE(JSON_EXTRACT(player_stats.data, ?)) AS DECIMAL(20,4)),
           0
         ) + CAST(? AS DECIMAL(20,4))
       )`,
    [userId, username, path, amount, path, path, amount]
  );
}

// ==================================================================
//  3. Таблица лидеров (Leaderboard)
// ==================================================================

async function leaderboard(ex, key, limit, offset, desc) {
  const direction = desc ? 'DESC' : 'ASC';

  if (DEDICATED_KEYS.has(key)) {
    const rows = await ex.query(
      `SELECT userId, username, \`${key}\` AS value, updated_at
       FROM player_stats
       ORDER BY \`${key}\` ${direction}, userId ASC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return rows.map((row) => ({
      userId: Number(row.userId),
      username: row.username,
      value: Number(row.value),
      updated_at: toIso(row.updated_at),
    }));
  }

  const path = jsonPath(key);
  const rows = await ex.query(
    `SELECT userId, username,
            CAST(JSON_UNQUOTE(JSON_EXTRACT(COALESCE(data, '{}'), ?)) AS DECIMAL(20,4)) AS value,
            updated_at
     FROM player_stats
     WHERE JSON_EXTRACT(data, ?) IS NOT NULL
     ORDER BY value ${direction}, userId ASC
     LIMIT ? OFFSET ?`,
    [path, path, limit, offset]
  );
  return rows.map((row) => ({
    userId: Number(row.userId),
    username: row.username,
    value: Number(row.value),
    updated_at: toIso(row.updated_at),
  }));
}

// ==================================================================
//  4. Инвентарь
// ==================================================================

async function listItems(ex, userId) {
  const rows = await ex.query(
    `SELECT itemKey, amount, meta, created_at, updated_at
     FROM player_items WHERE userId = ? ORDER BY itemKey ASC`,
    [userId]
  );
  return rows.map((row) => ({
    itemKey: row.itemKey,
    amount: Number(row.amount),
    meta: parseJsonColumn(row.meta),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }));
}

async function addItem(ex, userId, itemKey, amount) {
  const delta = Math.trunc(Number(amount) || 0);
  return ex.execute(
    `INSERT INTO player_items (userId, itemKey, amount) VALUES (?, ?, GREATEST(0, ?))
     ON DUPLICATE KEY UPDATE amount = GREATEST(0, amount + ?)`,
    [userId, itemKey, delta, delta]
  );
}

async function setItem(ex, userId, itemKey, amount, meta) {
  const total = Math.max(0, Math.trunc(Number(amount) || 0));
  return ex.execute(
    `INSERT INTO player_items (userId, itemKey, amount, meta) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       amount = VALUES(amount),
       meta = IF(VALUES(meta) IS NULL, meta, VALUES(meta))`,
    [userId, itemKey, total, meta === null || meta === undefined ? null : JSON.stringify(meta)]
  );
}

async function getItemAmount(ex, userId, itemKey) {
  const row = await ex.queryOne(
    'SELECT amount FROM player_items WHERE userId = ? AND itemKey = ? LIMIT 1',
    [userId, itemKey]
  );
  return row ? Number(row.amount) : 0;
}

async function itemTotals(ex, itemKey) {
  const row = await ex.queryOne(
    `SELECT COUNT(*) AS owners, COALESCE(SUM(amount), 0) AS total
     FROM player_items WHERE itemKey = ?`,
    [itemKey]
  );
  return { itemKey, owners: Number(row?.owners ?? 0), total: Number(row?.total ?? 0) };
}

// ==================================================================
//  5. Блокировки (Баны)
// ==================================================================

async function banPlayer(ex, userId, reason = 'Нарушение правил игры') {
  return ex.execute(
    `INSERT INTO player_stats (userId, is_banned, ban_reason) VALUES (?, 1, ?)
     ON DUPLICATE KEY UPDATE is_banned = 1, ban_reason = VALUES(ban_reason)`,
    [userId, reason]
  );
}

async function unbanPlayer(ex, userId) {
  return ex.execute(
    'UPDATE player_stats SET is_banned = 0, ban_reason = NULL WHERE userId = ?',
    [userId]
  );
}

async function getBanStatus(ex, userId) {
  const row = await ex.queryOne(
    'SELECT is_banned, ban_reason FROM player_stats WHERE userId = ? LIMIT 1',
    [userId]
  );
  return {
    userId,
    is_banned: Boolean(row?.is_banned),
    ban_reason: row?.ban_reason || null,
  };
}

// ==================================================================
//  6. Промокоды
// ==================================================================

async function createPromoCode(ex, {
  code,
  rewardCoins = 0,
  rewardGems = 0,
  rewardItem = null,
  rewardAmount = 0,
  maxUses = 0,
  expiresAt = null,
}) {
  return ex.execute(
    `INSERT INTO promo_codes
       (code, reward_coins, reward_gems, reward_item, reward_amount, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       reward_coins = VALUES(reward_coins),
       reward_gems = VALUES(reward_gems),
       reward_item = VALUES(reward_item),
       reward_amount = VALUES(reward_amount),
       max_uses = VALUES(max_uses),
       expires_at = VALUES(expires_at),
       is_active = 1`,
    [code, rewardCoins, rewardGems, rewardItem, rewardAmount, maxUses, expiresAt]
  );
}

async function redeemPromoCode(ex, userId, code) {
  return ex.transaction(async (tx) => {
    // 1. Проверяем существование и активность промокода
    const promo = await tx.queryOne(
      'SELECT * FROM promo_codes WHERE code = ? FOR UPDATE',
      [code]
    );
    if (!promo || !promo.is_active) {
      return { ok: false, error: 'Промокод не существует или не активен' };
    }

    // 2. Проверка срока действия
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return { ok: false, error: 'Срок действия промокода истёк' };
    }

    // 3. Проверка лимита использований
    if (promo.max_uses > 0 && promo.uses_count >= promo.max_uses) {
      return { ok: false, error: 'Лимит активаций этого промокода исчерпан' };
    }

    // 4. Проверяем, активировал ли игрок этот код ранее
    const alreadyRedeemed = await tx.queryOne(
      'SELECT id FROM code_redemptions WHERE userId = ? AND code = ? LIMIT 1',
      [userId, code]
    );
    if (alreadyRedeemed) {
      return { ok: false, error: 'Вы уже активировали этот промокод ранее' };
    }

    // 5. Фиксируем активацию
    await tx.execute(
      'INSERT INTO code_redemptions (userId, code) VALUES (?, ?)',
      [userId, code]
    );
    await tx.execute(
      'UPDATE promo_codes SET uses_count = uses_count + 1 WHERE code = ?',
      [code]
    );

    // 6. Начисляем награды
    const rewards = {
      coins: Number(promo.reward_coins || 0),
      gems: Number(promo.reward_gems || 0),
      item: promo.reward_item || null,
      amount: Number(promo.reward_amount || 0),
    };

    if (rewards.coins > 0) {
      await addStat(tx, userId, 'coins', rewards.coins);
    }
    if (rewards.gems > 0) {
      await addStat(tx, userId, 'gems', rewards.gems);
    }
    if (rewards.item && rewards.amount > 0) {
      await addItem(tx, userId, rewards.item, rewards.amount);
    }

    await db.writeLog(userId, 'promo_redeem', { code, rewards }, null, tx);

    return { ok: true, rewards };
  });
}

async function listPromoCodes(ex) {
  const rows = await ex.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
  return rows.map((r) => ({
    code: r.code,
    rewardCoins: Number(r.reward_coins),
    rewardGems: Number(r.reward_gems),
    rewardItem: r.reward_item,
    rewardAmount: Number(r.reward_amount),
    maxUses: Number(r.max_uses),
    usesCount: Number(r.uses_count),
    expiresAt: toIso(r.expires_at),
    isActive: Boolean(r.is_active),
    createdAt: toIso(r.created_at),
  }));
}

// ==================================================================
//  7. Защита от дюпов: Session Locking
// ==================================================================

/**
 * Захватывает сессию игрока на конкретном игровом сервере (jobId).
 * Если игрок уже на другом сервере и его heartbeat свежий (меньше 45с) — отклоняет вход.
 */
async function acquireSession(ex, userId, jobId, placeId = 0, ip = null) {
  const staleThresholdSec = 45;
  const current = await ex.queryOne(
    `SELECT jobId, TIMESTAMPDIFF(SECOND, heartbeat, CURRENT_TIMESTAMP) AS age
     FROM active_sessions WHERE userId = ? LIMIT 1`,
    [userId]
  );

  if (current && current.jobId !== jobId && Number(current.age) < staleThresholdSec) {
    return {
      acquired: false,
      message: 'Игрок уже подключен к другому серверу (защита от дублирования данных)',
    };
  }

  await ex.execute(
    `INSERT INTO active_sessions (userId, jobId, placeId, ip)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       jobId = VALUES(jobId),
       placeId = VALUES(placeId),
       ip = VALUES(ip),
       heartbeat = CURRENT_TIMESTAMP`,
    [userId, jobId, placeId, ip]
  );

  return { acquired: true };
}

async function releaseSession(ex, userId, jobId) {
  return ex.execute(
    'DELETE FROM active_sessions WHERE userId = ? AND jobId = ?',
    [userId, jobId]
  );
}

async function heartbeatSession(ex, userId, jobId) {
  return ex.execute(
    'UPDATE active_sessions SET heartbeat = CURRENT_TIMESTAMP WHERE userId = ? AND jobId = ?',
    [userId, jobId]
  );
}

// ==================================================================
//  8. Статистика и админка
// ==================================================================

async function getEconomyStats(ex) {
  const [players] = await ex.query(
    `SELECT COUNT(*) AS total_players,
            COALESCE(SUM(coins), 0) AS total_coins,
            COALESCE(SUM(gems), 0) AS total_gems,
            COALESCE(SUM(CASE WHEN is_banned = 1 THEN 1 ELSE 0 END), 0) AS banned_count
     FROM player_stats`
  );
  const [items] = await ex.query(
    'SELECT COUNT(*) AS unique_item_types, COALESCE(SUM(amount), 0) AS total_items FROM player_items'
  );
  const [sessions] = await ex.query('SELECT COUNT(*) AS active_count FROM active_sessions');

  return {
    players: Number(players?.total_players || 0),
    totalCoins: Number(players?.total_coins || 0),
    totalGems: Number(players?.total_gems || 0),
    bannedPlayers: Number(players?.banned_count || 0),
    totalItems: Number(items?.total_items || 0),
    activeSessions: Number(sessions?.active_count || 0),
  };
}

async function readLog(ex, userId, limit) {
  const rows = await ex.query(
    'SELECT id, userId, action, payload, ip, created_at FROM player_log WHERE userId = ? ORDER BY id DESC LIMIT ?',
    [userId, limit]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    userId: Number(row.userId),
    action: row.action,
    payload: parseJsonColumn(row.payload),
    ip: row.ip,
    created_at: toIso(row.created_at),
  }));
}

module.exports = {
  COIN_KEY,
  DEDICATED_KEYS,
  parseJsonColumn,
  readPath,
  writePath,
  getProfile,
  upsertProfile,
  deletePlayer,
  searchPlayers,
  getStat,
  setStat,
  addStat,
  leaderboard,
  listItems,
  addItem,
  setItem,
  getItemAmount,
  itemTotals,
  banPlayer,
  unbanPlayer,
  getBanStatus,
  createPromoCode,
  redeemPromoCode,
  listPromoCodes,
  acquireSession,
  releaseSession,
  heartbeatSession,
  getEconomyStats,
  readLog,
};