# Справочник REST API (v3.0.0)

Базовый адрес: `http://localhost:3000`  
Формат данных: JSON (кодировка UTF-8).  
Интерактивный список эндпоинтов: `GET http://localhost:3000/`

---

## Коды ответов

| Код | Значение | Описание |
|---|---|---|
| `200` | OK | Запрос выполнен успешно |
| `400` | Bad Request | Невалидные параметры, ошибка в JSON, неверный UserId |
| `401` | Unauthorized | Неверный или отсутствующий заголовок `x-api-key` |
| `404` | Not Found | Несуществующий путь |
| `409` | Conflict | Конфликт версий (Save Version) или сессия уже активна на другом сервере |
| `413` | Payload Too Large | Тело запроса превышает `BODY_LIMIT` |
| `429` | Too Many Requests | Превышен лимит запросов в минуту (Rate Limiter) |
| `500` | Internal Error | Ошибка выполнения SQL-запроса |
| `503` | Service Unavailable | База данных MariaDB недоступна (служба отключена) |

---

## 1. Профиль игрока

### `GET /player?userId=123`
Возвращает профиль игрока со всеми валютами, инвентарём и метаданными.

```json
{
  "ok": true,
  "found": true,
  "userId": 123,
  "username": "Player1",
  "coins": 500,
  "gems": 25,
  "level": 3,
  "xp": 120,
  "data": { "pets": { "dragon": { "level": 1 } } },
  "is_banned": false,
  "save_version": 4,
  "playtime_seconds": 360,
  "items": [
    { "itemKey": "sword", "amount": 1, "meta": null }
  ]
}
```

### `POST /player`
Создаёт или обновляет профиль игрока.
```json
{
  "userId": 123,
  "username": "Player1",
  "coins": 600,
  "gems": 30,
  "level": 4,
  "xp": 50,
  "data": { "vip": true },
  "expectedVersion": 4
}
```

### `POST /player/delete`
Полностью удаляет профиль, инвентарь, журнал и данные сессий игрока.
```json
{ "userId": 123 }
```

---

## 2. Статистика и Произвольные Поля

### `GET /stat?userId=123&key=coins`
Получить значение конкретного поля (поддерживает как колонки `coins`, `gems`, `level`, `xp`, так и вложенные пути `data`: `pets.dragon.level`).

### `POST /set-stat`
Записать точное значение поля:
```json
{ "userId": 123, "key": "level", "value": 5 }
```

### `POST /add-stat`
Атомарно прибавить число к полю (не опускается ниже нуля в MariaDB):
```json
{ "userId": 123, "key": "coins", "delta": 100 }
```

---

## 3. Таблица лидеров

### `GET /leaderboard?key=coins&limit=10&offset=0&order=desc`
Топ игроков по любому параметру (`coins`, `gems`, `level`, `xp` или любому JSON-полю).
```json
{
  "ok": true,
  "key": "coins",
  "count": 2,
  "players": [
    { "position": 1, "userId": 123, "username": "Player1", "value": 5000 },
    { "position": 2, "userId": 456, "username": "Player2", "value": 2500 }
  ]
}
```

---

## 4. Инвентарь

- `GET /items?userId=123` — список всех предметов игрока.
- `GET /items/get?userId=123&itemKey=sword` — количество конкретного предмета.
- `POST /items/add` — добавить/убавить количество (`{ "userId": 123, "itemKey": "sword", "amount": 1 }`).
- `POST /items/set` — установить количество с метаданными (`{ "userId": 123, "itemKey": "sword", "amount": 1, "meta": { "durability": 100 } }`).

---

## 5. Система Блокировок (Баны)

### `POST /player/ban`
Заблокировать игрока:
```json
{
  "userId": 123,
  "reason": "Использование читов / эксплоитов"
}
```

### `POST /player/unban`
Разблокировать игрока:
```json
{ "userId": 123 }
```

### `GET /player/ban?userId=123`
Проверить статус бана игрока.

---

## 6. Система Промокодов

### `POST /code/create`
Создать промокод с наградами:
```json
{
  "code": "PROMO2026",
  "rewardCoins": 1000,
  "rewardGems": 50,
  "rewardItem": "special_cape",
  "rewardAmount": 1,
  "maxUses": 100,
  "expiresAt": "2026-12-31T23:59:59Z"
}
```

### `POST /code/redeem`
Активировать промокод от имени игрока:
```json
{
  "userId": 123,
  "code": "PROMO2026"
}
```
*Начисление наград и запись в реестр происходят в одной неделимой SQL-транзакции!*

### `GET /code/list`
Список всех созданных промокодов.

---

## 7. Session Locking (Защита от дюпов)

- `POST /session/acquire` — захват сессии при входе на сервер (`{ "userId": 123, "jobId": "...", "placeId": 0 }`).
- `POST /session/release` — освобождение сессии при выходе (`{ "userId": 123, "jobId": "..." }`).
- `POST /session/heartbeat` — обновление отметки активности сессии.

---

## 8. Статистика и Админка

### `GET /admin/stats`
Сводка по игре:
```json
{
  "ok": true,
  "players": 142,
  "totalCoins": 1582000,
  "totalGems": 4200,
  "bannedPlayers": 3,
  "totalItems": 580,
  "activeSessions": 12
}
```