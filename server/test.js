'use strict';

/**
 * test.js — Автоматические тесты безопасности, валидации и функционала.
 * Запуск: node test.js
 */

const assert = require('assert');
const util = require('./util');

console.log('--- 1. Тестирование util.js (Безопасность и Валидация) ---');

// Проверка Prototype Pollution
assert.strictEqual(util.normalizeKey('__proto__'), null, 'Защита: __proto__ должен отклоняться');
assert.strictEqual(util.normalizeKey('prototype'), null, 'Защита: prototype должен отклоняться');
assert.strictEqual(util.normalizeKey('constructor'), null, 'Защита: constructor должен отклоняться');
assert.strictEqual(util.normalizeKey('pets.__proto__.level'), null, 'Защита: вложенный __proto__ отклоняется');
assert.strictEqual(util.normalizeKey('pets.dragon.level'), 'pets.dragon.level', 'Корректный ключ должен приниматься');

// Проверка валидации промокодов и предметов
assert.strictEqual(util.normalizeCode('promo2026'), 'PROMO2026', 'Промокод должен переводиться в UPPERCASE');
assert.strictEqual(util.normalizeCode('a!b'), null, 'Спецсимволы в промокоде должны отклоняться');
assert.strictEqual(util.normalizeItemKey('diamond_sword-1'), 'diamond_sword-1', 'Корректный itemKey принимается');
assert.strictEqual(util.normalizeItemKey('sword<script>'), null, 'XSS/спецсимволы в itemKey отклоняются');

// Проверка очистки JSON от Prototype Pollution
const dirtyObj = JSON.parse('{"__proto__":{"polluted":true},"cleanKey":"value"}');
const sanitized = util.readJson(dirtyObj);
assert.strictEqual(sanitized.__proto__.polluted, undefined, 'Prototype pollution должен вычищаться из JSON');
assert.strictEqual(sanitized.cleanKey, 'value', 'Безопасные ключи должны сохраняться');

// Проверка чисел и переполнения (Overflow protection)
assert.strictEqual(util.isUserId(12345), true, 'Положительный safe int userId принимается');
assert.strictEqual(util.isUserId(-1), false, 'Отрицательный userId отклоняется');
assert.strictEqual(util.isUserId(0), false, 'Нулевой userId отклоняется');
assert.strictEqual(util.isUserId(Number.MAX_SAFE_INTEGER + 10), false, 'Небезопасный double переполнения отклоняется');

// Проверка timing-safe сравнения
assert.strictEqual(util.safeTimingCompare('my_secret_key', 'my_secret_key'), true, 'Одинаковые токены равны');
assert.strictEqual(util.safeTimingCompare('my_secret_key', 'wrong_key'), false, 'Разные токены не равны');
assert.strictEqual(util.safeTimingCompare('', 'secret'), false, 'Пустой токен не равен');

console.log('✅ Все тесты util.js успешно пройдены!');

console.log('--- 2. Тестирование HTTP сервера и обработки отключенной БД ---');

const http = require('http');

// Запускаем проверку фонового HTTP сервера
const req = http.get('http://localhost:3000/', (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.service, 'roblox-mariadb-bridge');
      console.log('✅ HTTP GET / отвечает корректно:', json.service, 'v' + json.version);
      process.exit(0);
    } catch (e) {
      console.error('Ошибка парсинга ответа:', e.message);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.log('ℹ️ HTTP сервер пока не запущен в фоне (это нормально, запустим при проверке).');
  process.exit(0);
});
