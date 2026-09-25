'use strict';

// 数据库迁移。PRAGMA user_version 记录已执行到第几个迁移；
// 只能在末尾追加新迁移，不能修改已发布的迁移。

const MIGRATIONS = [
  // 1：初始表结构（设计文档第 3 节）
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    openid        TEXT UNIQUE,
    nickname      TEXT NOT NULL DEFAULT '',
    avatar        TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE games (
    id           TEXT PRIMARY KEY,
    mode         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    komi         REAL NOT NULL,
    black_id     INTEGER,
    white_id     INTEGER,
    ai_level     TEXT,
    time_control TEXT,
    status       TEXT NOT NULL,
    moves        TEXT NOT NULL DEFAULT '[]',
    clocks       TEXT,
    dead         TEXT,
    winner       INTEGER,
    reason       TEXT,
    score_black  REAL,
    score_white  REAL,
    result_text  TEXT,
    counted      INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    ended_at     INTEGER
  );
  CREATE INDEX games_black ON games(black_id, created_at);
  CREATE INDEX games_white ON games(white_id, created_at);
  CREATE INDEX games_status ON games(status);
  CREATE TABLE user_stats (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    games          INTEGER NOT NULL DEFAULT 0,
    wins           INTEGER NOT NULL DEFAULT 0,
    losses         INTEGER NOT NULL DEFAULT 0,
    draws          INTEGER NOT NULL DEFAULT 0,
    cur_streak     INTEGER NOT NULL DEFAULT 0,
    max_streak     INTEGER NOT NULL DEFAULT 0,
    cur_streak_at  INTEGER,
    max_streak_at  INTEGER,
    updated_at     INTEGER NOT NULL
  );
  `,
  // 2：令牌表的索引（登录时按用户清理过期令牌、定时清理全部过期令牌都不再全表扫描）；
  //    人机战绩的部分索引（只含计入战绩的人机对局，作废的不进索引）
  `
  CREATE INDEX sessions_user ON sessions(user_id, created_at);
  CREATE INDEX sessions_expires ON sessions(expires_at);
  CREATE INDEX games_ai_black ON games(black_id, winner) WHERE mode = 'ai' AND status = 'ended' AND reason != 'abort';
  CREATE INDEX games_ai_white ON games(white_id, winner) WHERE mode = 'ai' AND status = 'ended' AND reason != 'abort';
  `,
  // 3：state —— 对局进行中要随进度保存的会话状态（JSON：已用的"继续对局"次数、继续对局保护），重启后恢复；
  //    cause —— 终局的细分原因（如 first_move / arrival / abandon / score_dispute / resume_undone），客户端据此说明结果
  `
  ALTER TABLE games ADD COLUMN state TEXT;
  ALTER TABLE games ADD COLUMN cause TEXT;
  `,
];

function currentVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version);
}

// 按序执行尚未执行的迁移，每个迁移一个事务。返回迁移后的版本号。
function migrate(db, migrations = MIGRATIONS) {
  let version = currentVersion(db);
  if (version > migrations.length) {
    throw new Error(`数据库版本 ${version} 比程序支持的 ${migrations.length} 新，请升级服务端代码`);
  }
  while (version < migrations.length) {
    const step = migrations[version];
    const next = version + 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof step === 'function') step(db);
      else db.exec(step);
      // PRAGMA 不支持参数绑定；next 是程序内的整数，不存在注入
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      err.message = `数据库迁移 ${next} 失败：${err.message}`;
      throw err;
    }
    version = next;
  }
  return version;
}

module.exports = { MIGRATIONS, migrate, currentVersion };
