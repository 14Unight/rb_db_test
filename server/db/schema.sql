-- =============================================================
--  Roblox <-> MariaDB : схема базы данных (v3.0.0)
--
--  Этот файл применяется автоматически сервером при старте
--  (server/db.js делает CREATE DATABASE, затем выполняет этот файл).
-- =============================================================

-- -------------------------------------------------------------
--  1. player_stats — основная таблица профилей игроков
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_stats (
  userId           BIGINT UNSIGNED NOT NULL,
  username         VARCHAR(64)      NOT NULL DEFAULT '',
  coins            BIGINT           NOT NULL DEFAULT 0,
  gems             BIGINT           NOT NULL DEFAULT 0,
  level            INT UNSIGNED     NOT NULL DEFAULT 1,
  xp               BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  data             JSON             NULL,
  is_banned        TINYINT(1)       NOT NULL DEFAULT 0,
  ban_reason       VARCHAR(255)     NULL,
  save_version     INT UNSIGNED     NOT NULL DEFAULT 1,
  playtime_seconds INT UNSIGNED     NOT NULL DEFAULT 0,
  last_ip          VARCHAR(45)      NULL,
  last_login       TIMESTAMP        NULL,
  created_at       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (userId),
  KEY idx_coins    (coins, userId),
  KEY idx_gems     (gems, userId),
  KEY idx_level    (level, userId),
  KEY idx_username (username),
  KEY idx_banned   (is_banned)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  2. player_items — универсальный инвентарь и коллекции
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_items (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  userId     BIGINT UNSIGNED NOT NULL,
  itemKey    VARCHAR(64)     NOT NULL,
  amount     INT             NOT NULL DEFAULT 0,
  meta       JSON            NULL,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_item (userId, itemKey),
  KEY idx_item (itemKey),
  CONSTRAINT fk_player_items_user
    FOREIGN KEY (userId) REFERENCES player_stats (userId)
    ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  3. player_log — аудит и журнал действий (античит/отладка)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  userId     BIGINT UNSIGNED NOT NULL,
  action     VARCHAR(64)     NOT NULL,
  payload    JSON            NULL,
  ip         VARCHAR(45)     NULL,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_time (userId, created_at),
  KEY idx_action    (action)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  4. active_sessions — защита от дюпа (Session Locking)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS active_sessions (
  userId     BIGINT UNSIGNED NOT NULL,
  jobId      VARCHAR(128)    NOT NULL,
  placeId    BIGINT          NOT NULL DEFAULT 0,
  ip         VARCHAR(45)     NULL,
  heartbeat  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (userId),
  KEY idx_heartbeat (heartbeat)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  5. promo_codes — система промокодов
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_codes (
  code          VARCHAR(64)      NOT NULL,
  reward_coins  BIGINT           NOT NULL DEFAULT 0,
  reward_gems   BIGINT           NOT NULL DEFAULT 0,
  reward_item   VARCHAR(64)      NULL,
  reward_amount INT              NOT NULL DEFAULT 0,
  max_uses      INT              NOT NULL DEFAULT 0,
  uses_count    INT              NOT NULL DEFAULT 0,
  expires_at    TIMESTAMP        NULL,
  is_active     TINYINT(1)       NOT NULL DEFAULT 1,
  created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -------------------------------------------------------------
--  6. code_redemptions — учет активаций промокодов игроками
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_redemptions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(64)     NOT NULL,
  userId      BIGINT UNSIGNED NOT NULL,
  redeemed_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_code (userId, code),
  KEY idx_code (code)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;