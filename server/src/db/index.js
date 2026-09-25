'use strict';
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('./migrations');
const { createRepos } = require('./repos');

// 打开 SQLite 数据库并执行迁移。path 可为 ':memory:'（测试）。
function openDb(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('openDb: 需要数据库文件路径');
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') {
      // WAL：读写不互相阻塞；NORMAL 在 WAL 下足够安全（掉电最多丢最后几个事务，不会损坏）
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

module.exports = { openDb, createRepos, migrate };
