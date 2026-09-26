-- 围棋小程序服务端数据库结构（MySQL 8，utf8mb4 / InnoDB）
-- 与 Node 版 server/src/db/migrations.js 的最新结构（迁移 1~3）一致：表、列、索引相同，类型按 MySQL 调整：
--   自增 id 与时间戳用 BIGINT（毫秒时间戳），对局 id、会话令牌等字符串主键用 VARCHAR，JSON 字段存 TEXT，布尔值存 TINYINT(0/1)。
-- 服务启动时自动执行本文件（spring.sql.init.mode=always），全部是 CREATE TABLE IF NOT EXISTS，可重复执行。
-- 需要区分大小写的列（openid、令牌、对局 id）使用 utf8mb4_bin 排序规则。

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '用户 id（自增）',
  openid        VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '微信 openid；开发登录为 dev:<deviceId>',
  nickname      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '昵称（1~16 个字符，空串表示还没设置）',
  avatar        VARCHAR(128) NOT NULL DEFAULT '' COMMENT '头像文件名（不含域名），空串表示无',
  created_at    BIGINT       NOT NULL COMMENT '注册时间（毫秒时间戳）',
  last_login_at BIGINT       NOT NULL COMMENT '最近登录时间（毫秒时间戳）',
  PRIMARY KEY (id),
  UNIQUE KEY users_openid (openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户';

-- 登录令牌
CREATE TABLE IF NOT EXISTS sessions (
  token      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '令牌：32 字节随机数的 hex（64 位小写）',
  user_id    BIGINT      NOT NULL COMMENT '所属用户 id',
  created_at BIGINT      NOT NULL COMMENT '签发时间（毫秒时间戳）',
  expires_at BIGINT      NOT NULL COMMENT '过期时间：30 天，使用时剩余不足 15 天则续到 30 天',
  PRIMARY KEY (token),
  KEY sessions_user (user_id, created_at),
  KEY sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='登录令牌（每个用户最多保留最新的 10 个）';

-- 对局
CREATE TABLE IF NOT EXISTS games (
  id           VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '对局 id：12 位随机 base36',
  mode         VARCHAR(16) NOT NULL COMMENT '模式：ranked 排位 / friend 好友房 / ai 人机',
  size         INT         NOT NULL COMMENT '棋盘路数：9 / 13 / 19',
  komi         DOUBLE      NOT NULL COMMENT '贴目（黑贴 7.5）',
  black_id     BIGINT      NULL COMMENT '执黑用户 id，AI 一方为 NULL',
  white_id     BIGINT      NULL COMMENT '执白用户 id，AI 一方为 NULL',
  ai_level     VARCHAR(32) NULL COMMENT '人机对局的 AI 难度 id，否则 NULL',
  time_control TEXT        NULL COMMENT 'JSON 读秒设置 {mainMs, periods, periodMs}，人机为 NULL',
  status       VARCHAR(16) NOT NULL COMMENT '状态：playing 对局中 / scoring 数子中 / ended 已结束',
  moves        TEXT        NOT NULL COMMENT 'JSON 着手序列：落子为 idx(y*n+x)，pass 为 -1，黑先',
  clocks       TEXT        NULL COMMENT 'JSON 读秒快照（重启恢复用）',
  dead         TEXT        NULL COMMENT 'JSON 死子数组（终局时）',
  winner       TINYINT     NULL COMMENT '胜者：0 和棋/作废，1 黑，2 白；未结束为 NULL',
  reason       VARCHAR(16) NULL COMMENT '终局方式：score 数子 / resign 认输 / timeout 超时 / abort 作废',
  score_black  DOUBLE      NULL COMMENT '黑方点数（数子终局时）',
  score_white  DOUBLE      NULL COMMENT '白方点数（含贴目）',
  result_text  VARCHAR(32) NULL COMMENT '结果文本：B+R / W+T / B+3.5 / 0 / Void',
  counted      TINYINT     NOT NULL DEFAULT 0 COMMENT '已计入排行统计为 1（只由统计更新置 1，保证同一局只计一次）',
  created_at   BIGINT      NOT NULL COMMENT '开局时间（毫秒时间戳）',
  updated_at   BIGINT      NOT NULL COMMENT '最近保存时间（毫秒时间戳）',
  ended_at     BIGINT      NULL COMMENT '终局时间（毫秒时间戳）',
  state        TEXT        NULL COMMENT 'JSON 会话附加状态 {resumesUsed, guard}，进行中随进度保存，终局清空',
  cause        VARCHAR(32) NULL COMMENT '终局细分原因，如 agreed / deadline / first_move / arrival / abandon / clock',
  PRIMARY KEY (id),
  KEY games_black (black_id, created_at),
  KEY games_white (white_id, created_at),
  KEY games_status (status),
  -- MySQL 没有部分索引：人机战绩用覆盖索引（Node/SQLite 版为 WHERE mode='ai' AND status='ended' AND reason!='abort' 的部分索引）
  KEY games_ai_black (black_id, mode, status, reason, winner),
  KEY games_ai_white (white_id, mode, status, reason, winner)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='对局记录';

-- 排位统计（只统计排位赛）
CREATE TABLE IF NOT EXISTS user_stats (
  user_id       BIGINT NOT NULL COMMENT '用户 id',
  games         INT    NOT NULL DEFAULT 0 COMMENT '排位总局数',
  wins          INT    NOT NULL DEFAULT 0 COMMENT '胜局数',
  losses        INT    NOT NULL DEFAULT 0 COMMENT '负局数',
  draws         INT    NOT NULL DEFAULT 0 COMMENT '和棋数',
  cur_streak    INT    NOT NULL DEFAULT 0 COMMENT '当前连胜',
  max_streak    INT    NOT NULL DEFAULT 0 COMMENT '最高连胜',
  cur_streak_at BIGINT NULL COMMENT '当前连胜达到现值的时间（毫秒时间戳）',
  max_streak_at BIGINT NULL COMMENT '最高连胜达到现值的时间（毫秒时间戳）',
  updated_at    BIGINT NOT NULL COMMENT '最近更新时间（毫秒时间戳）',
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_stats_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='排位统计';
