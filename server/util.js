'use strict';

/**
 * util.js — Валидация, безопасность и приведение типов.
 *
 * Содержит функции для:
 *  - Защиты от Prototype Pollution и Injection
 *  - Безопасного сравнения токенов (timing-safe)
 *  - Валидации чисел с контролем переполнения (overflow protection)
 *  - Очистки и санитизации строк
 */

const crypto = require('crypto');

/** Ключ статистики: `level`, `pets.dragon.level`, `quest.main`. Буквы, цифры, _, до 5 сегментов. */
const KEY_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,4}$/;

/** Идентификатор предмета: `sword`, `potion_hp`, `vip-badge`. Буквы, цифры, _, ., - */
const ITEM_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Промокод: только буквы, цифры, _, - от 3 до 32 символов */
const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** Запрещённые имена ключей для защиты от Prototype Pollution */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Максимальное безопасное целое число для балансов и ID (IEEE 754 Safe Integer) */
const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER; // 9007199254740991

/**
 * Приводит значение к целому числу с проверкой границ.
 */
function toInt(value, fallback = 0, min = -MAX_SAFE_INT, max = MAX_SAFE_INT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const truncated = Math.trunc(n);
  return Math.min(Math.max(truncated, min), max);
}

/**
 * Приводит значение к числу с плавающей точкой с проверкой границ.
 */
function toNum(value, fallback = 0, min = -MAX_SAFE_INT, max = MAX_SAFE_INT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Проверяет, является ли значение корректным Roblox UserId (1..2^53-1).
 */
function isUserId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_SAFE_INT;
}

/**
 * Проверяет и нормализует ключ статистики (например, 'coins', 'pets.dragon.level').
 * Защищает от Prototype Pollution и спецсимволов.
 */
function normalizeKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key || key.length > 64 || !KEY_RE.test(key)) return null;

  const parts = key.split('.');
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part.toLowerCase())) return null;
  }
  return key;
}

/**
 * Проверяет и нормализует идентификатор предмета инвентаря.
 */
function normalizeItemKey(value) {
  if (typeof value !== 'string') return null;
  const key = cleanString(value, 64);
  if (!key || !ITEM_KEY_RE.test(key) || FORBIDDEN_KEYS.has(key.toLowerCase())) return null;
  return key;
}

/**
 * Проверяет и нормализует промокод (приводит к UPPERCASE).
 */
function normalizeCode(value) {
  if (typeof value !== 'string') return null;
  const code = cleanString(value, 32).toUpperCase();
  if (!code || !CODE_RE.test(code)) return null;
  return code;
}

/**
 * 'level' / 'pets.dragon.level' -> '$.level' / '$.pets.dragon.level'
 */
function jsonPath(key) {
  return `$.${key}`;
}

/**
 * Обрезает строку до максимальной длины и удаляет управляющие символы.
 */
function cleanString(value, maxLength = 64) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

/**
 * Безопасно парсит или валидирует JSON-объект с проверкой глубины вложенности
 * и блокировкой Prototype Pollution.
 */
function readJson(value, maxDepth = 6) {
  if (value === null || value === undefined) return null;

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    return null;
  }

  // Рекурсивная проверка на Prototype Pollution и глубину
  function sanitizeObject(obj, depth) {
    if (depth > maxDepth) return {};
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue;
      if (v !== null && typeof v === 'object') {
        if (Array.isArray(v)) {
          clean[k] = v.slice(0, 100); // Ограничиваем массивы до 100 элементов
        } else {
          clean[k] = sanitizeObject(v, depth + 1);
        }
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

  return sanitizeObject(parsed, 1);
}

/**
 * Значения, которые MariaDB умеет сохранять в JSON.
 */
function isJsonValue(value) {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  );
}

/**
 * Timing-safe сравнение строк (защита от атак по времени на API_KEY).
 * Сравнивает SHA-256 хеши, что гарантирует одинаковую длину буферов.
 */
function safeTimingCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

module.exports = {
  toInt,
  toNum,
  isUserId,
  normalizeKey,
  normalizeItemKey,
  normalizeCode,
  jsonPath,
  cleanString,
  readJson,
  isJsonValue,
  safeTimingCompare,
  KEY_RE,
  ITEM_KEY_RE,
  CODE_RE,
  MAX_SAFE_INT,
};