-- 测试用（H2，MODE=MySQL）：与 schema-mysql.sql 的表、列、索引一一对应，只去掉了 H2 不支持的 MySQL 表选项。
-- 改表结构时两个文件要同时改（SchemaTest 会检查两边的列名一致）。

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  openid        VARCHAR(128) NULL,
  nickname      VARCHAR(64)  NOT NULL DEFAULT '',
  avatar        VARCHAR(128) NOT NULL DEFAULT '',
  created_at    BIGINT       NOT NULL,
  last_login_at BIGINT       NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT users_openid UNIQUE (openid)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      VARCHAR(64) NOT NULL,
  user_id    BIGINT      NOT NULL,
  created_at BIGINT      NOT NULL,
  expires_at BIGINT      NOT NULL,
  PRIMARY KEY (token),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS games (
  id           VARCHAR(64) NOT NULL,
  mode         VARCHAR(16) NOT NULL,
  size         INT         NOT NULL,
  komi         DOUBLE      NOT NULL,
  black_id     BIGINT      NULL,
  white_id     BIGINT      NULL,
  ai_level     VARCHAR(32) NULL,
  time_control TEXT        NULL,
  status       VARCHAR(16) NOT NULL,
  moves        TEXT        NOT NULL,
  clocks       TEXT        NULL,
  dead         TEXT        NULL,
  winner       TINYINT     NULL,
  reason       VARCHAR(16) NULL,
  score_black  DOUBLE      NULL,
  score_white  DOUBLE      NULL,
  result_text  VARCHAR(32) NULL,
  counted      TINYINT     NOT NULL DEFAULT 0,
  created_at   BIGINT      NOT NULL,
  updated_at   BIGINT      NOT NULL,
  ended_at     BIGINT      NULL,
  state        TEXT        NULL,
  cause        VARCHAR(32) NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS games_black ON games (black_id, created_at);
CREATE INDEX IF NOT EXISTS games_white ON games (white_id, created_at);
CREATE INDEX IF NOT EXISTS games_status ON games (status);
CREATE INDEX IF NOT EXISTS games_ai_black ON games (black_id, mode, status, reason, winner);
CREATE INDEX IF NOT EXISTS games_ai_white ON games (white_id, mode, status, reason, winner);

CREATE TABLE IF NOT EXISTS user_stats (
  user_id       BIGINT NOT NULL,
  games         INT    NOT NULL DEFAULT 0,
  wins          INT    NOT NULL DEFAULT 0,
  losses        INT    NOT NULL DEFAULT 0,
  draws         INT    NOT NULL DEFAULT 0,
  cur_streak    INT    NOT NULL DEFAULT 0,
  max_streak    INT    NOT NULL DEFAULT 0,
  cur_streak_at BIGINT NULL,
  max_streak_at BIGINT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_stats_user FOREIGN KEY (user_id) REFERENCES users (id)
);
