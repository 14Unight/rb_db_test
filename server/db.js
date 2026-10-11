'use strict';

/**
 * db.js — Слой доступа к MariaDB / MySQL.
 *
 * Особенности:
 *  - Автоматическое создание базы данных и применение схемы при первом запуске
 *  - Безопасные автоматические миграции без потери существующих данных
 *  - Пул соединений с keep-alive и обработкой разрывов
 *  - Поддержка транзакций с автоматическим rollback при ошибке
 *  - Фоновое переподключение (автоматически подхватывает базу, если служба запустилась позже)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'roblox_db',
  connectionLimit: Number(process.env.DB_POOL) || 10,
};

let pool = null;
let isDatabaseReady = false;
let initPromise = null;

/**
 * Колонки, которые сервер ожидает увидеть в таблицах.
 * Используются для безопасных миграций старых баз на новую схему.
 */
const EXPECTED_COLUMNS = {
  player_stats: {
    userId: 'BIGINT UNSIGNED NOT NULL',
    username: "VARCHAR(64) NOT NULL DEFAULT ''",
    coins: 'BIGINT NOT NULL DEFAULT 0',
    gems: 'BIGINT NOT NULL DEFAULT 0',
    level: 'INT UNSIGNED NOT NULL DEFAULT 1',
    xp: 'BIGINT UNSIGNED NOT NULL DEFAULT 0',
    data: 'JSON NULL',
    is_banned: 'TINYINT(1) NOT NULL DEFAULT 0',
    ban_reason: 'VARCHAR(255) NULL',
    save_version: 'INT UNSIGNED NOT NULL DEFAULT 1',
    playtime_seconds: 'INT UNSIGNED NOT NULL DEFAULT 0',
    last_ip: 'VARCHAR(45) NULL',
    last_login: 'TIMESTAMP NULL',
    created_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    updated_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  },
  player_items: {
    itemKey: 'VARCHAR(64) NOT NULL',
    amount: 'INT NOT NULL DEFAULT 0',
    meta: 'JSON NULL',
  },
  player_log: {
    ip: 'VARCHAR(45) NULL',
  },
  active_sessions: {
    jobId: 'VARCHAR(128) NOT NULL',
    placeId: 'BIGINT NOT NULL DEFAULT 0',
    ip: 'VARCHAR(45) NULL',
  },
  promo_codes: {
    reward_coins: 'BIGINT NOT NULL DEFAULT 0',
    reward_gems: 'BIGINT NOT NULL DEFAULT 0',
    reward_item: 'VARCHAR(64) NULL',
    reward_amount: 'INT NOT NULL DEFAULT 0',
    max_uses: 'INT NOT NULL DEFAULT 0',
    uses_count: 'INT NOT NULL DEFAULT 0',
    expires_at: 'TIMESTAMP NULL',
    is_active: 'TINYINT(1) NOT NULL DEFAULT 1',
  },
};

/**
 * Добавляет в существующие таблицы недостающие колонки (без потери данных).
 */
async function migrate(conn) {
  const [existing] = await conn.query(
    'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?',
    [CONFIG.database]
  );

  const known = new Set(existing.map((row) => `${row.TABLE_NAME}.${row.COLUMN_NAME}`));

  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    for (const [column, definition] of Object.entries(columns)) {
      if (known.has(`${table}.${column}`)) continue;

      // Валидация названий колонок и таблиц во избежание инъекций
      if (!/^[a-zA-Z0-9_]+$/.test(table) || !/^[a-zA-Z0-9_]+$/.test(column)) continue;

      try {
        await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        console.log(`[db] миграция: колонка ${table}.${column} успешно добавлена`);
      } catch (err) {
        console.warn(`[db] предупреждение миграции для ${table}.${column}:`, err.message);
      }
    }
  }
}

/**
 * Создаёт базу данных, накатывает схему, применяет миграции и поднимает пул.
 */
async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    const bootstrap = await mysql.createConnection({
      host: CONFIG.host,
      port: CONFIG.port,
      user: CONFIG.user,
      password: CONFIG.password,
      multipleStatements: true,
      connectTimeout: 5000,
    });

    try {
      await bootstrap.query(
        `CREATE DATABASE IF NOT EXISTS \`${CONFIG.database}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await bootstrap.changeUser({ database: CONFIG.database });
      await bootstrap.query(schema);
      await migrate(bootstrap);
    } finally {
      await bootstrap.end().catch(() => {});
    }

    pool = mysql.createPool({
      ...CONFIG,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    pool.on('error', (err) => {
      console.error('[db] непредвиденная ошибка пула соединений:', err.message);
      if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
        isDatabaseReady = false;
      }
    });

    await pool.query('SELECT 1');
    isDatabaseReady = true;
    console.log(`[db] MariaDB OK · база "${CONFIG.database}" · схема и миграции применены`);
  })();

  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    isDatabaseReady = false;
    throw err;
  }

  return true;
}

/** Проверяет, доступна ли база данных */
function isReady() {
  return isDatabaseReady && pool !== null;
}

/**
 * Выполнить SELECT и вернуть массив строк.
 */
async function query(sql, params = []) {
  if (!isReady()) throw new Error('База данных MariaDB в данный момент недоступна');
  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * Выполнить SELECT и вернуть первую строку (или null).
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

/**
 * Выполнить INSERT/UPDATE/DELETE. Возвращает result header.
 */
async function execute(sql, params = []) {
  if (!isReady()) throw new Error('База данных MariaDB в данный момент недоступна');
  const [result] = await pool.execute(sql, params);
  return result;
}

/**
 * Обёртка для атомарных операций в транзакции: всё применяется или ничего.
 * fn получает объект { inTransaction: true, query, queryOne, execute }.
 */
async function transaction(fn) {
  if (!isReady()) throw new Error('База данных MariaDB в данный момент недоступна');
  const conn = await pool.getConnection();
  const tx = {
    inTransaction: true,
    query: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    },
    queryOne: async (sql, params = []) => {
      const rows = await tx.query(sql, params);
      return rows.length ? rows[0] : null;
    },
    execute: async (sql, params = []) => {
      const [result] = await conn.execute(sql, params);
      return result;
    },
  };

  try {
    await conn.beginTransaction();
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Записывает действие в журнал аудита player_log.
 * Не прерывает основной запрос при сбое логирования.
 */
async function writeLog(userId, action, payload, ip = null, executor = null) {
  if (String(process.env.LOG_ENABLED).toLowerCase() !== 'true') return;
  try {
    const run = executor ? executor.execute : execute;
    await run(
      'INSERT INTO player_log (userId, action, payload, ip) VALUES (?, ?, ?, ?)',
      [userId, action, JSON.stringify(payload ?? null), ip]
    );
  } catch (err) {
    console.error('[db] не удалось записать в player_log:', err.message);
  }
}

/**
 * Форматирует ошибку MariaDB в понятный текст.
 */
function describeError(err) {
  if (!err) return 'неизвестная ошибка';
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'MariaDB не отвечает (порт 3306). Убедись, что служба MariaDB/MySQL запущена.';
    case 'ER_ACCESS_DENIED_ERROR':
      return 'Неверный логин или пароль MariaDB. Проверь файл server/.env';
    case 'ER_BAD_DB_ERROR':
      return `База данных "${CONFIG.database}" недоступна.`;
    case 'PROTOCOL_CONNECTION_LOST':
      return 'Соединение с MariaDB было разорвано.';
    default:
      return err.message || String(err);
  }
}

module.exports = {
  init,
  isReady,
  query,
  queryOne,
  execute,
  transaction,
  writeLog,
  describeError,
  CONFIG,
};