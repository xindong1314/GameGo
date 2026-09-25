'use strict';
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

// 服务端配置。loadConfig 读取环境变量（以及 server/.env），defaultConfig 给测试用。
// 相对路径（DATA_DIR、KATAGO_MODEL、KATAGO_CONFIG 等）一律相对于 server/ 目录解析，
// 与启动时的工作目录无关（systemd 下 cwd 往往不是项目目录）。

const SERVER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_FILE = path.join(SERVER_ROOT, '.env');

// 读秒预设（第 6.1 节）：9 路 3 分钟 + 3×20 秒；13 路 6 分钟 + 3×30 秒；19 路 10 分钟 + 3×30 秒
const DEFAULT_TIME_CONTROLS = {
  9: { mainMs: 180000, periods: 3, periodMs: 20000 },
  13: { mainMs: 360000, periods: 3, periodMs: 30000 },
  19: { mainMs: 600000, periods: 3, periodMs: 30000 },
};

const DEFAULTS = {
  port: 8080,
  host: '0.0.0.0',
  publicBaseUrl: 'http://localhost:8080',
  dataDir: './data',
  katagoConfig: './katago/analysis.cfg',
  komi: 7.5,
  minMovesRanked: 10,
  minGamesWinrate: 10,
  rankedPairDailyMax: 3,
  firstMoveTimeoutMs: 60000,
  abandonMs: 90000,
  scoringTimeoutMs: 180000,
  judgeTimeoutMs: 15000,
  aiIdleTimeoutMs: 86400000,
  roomTtlMs: 1800000,
};

class ConfigError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConfigError';
  }
}

// 空串、纯空白视为未设置（.env 里写 `KATAGO_MODEL=` 等于不配置）
function str(env, name) {
  const v = env[name];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function parseIntVar(env, name, def, { min, max }) {
  const raw = str(env, name);
  if (!raw) return def;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} 必须是整数，当前为 "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} 必须在 ${min}~${max} 之间，当前为 ${raw}`);
  }
  return n;
}

function parseBoolVar(env, name, def) {
  const raw = str(env, name).toLowerCase();
  if (!raw) return def;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} 只能是 1 或 0，当前为 "${env[name]}"`);
}

// "基本秒,读秒次数,每次秒"，如 "600,3,30"
function parseTimeControl(raw, name) {
  const parts = String(raw).split(',').map((s) => s.trim());
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) {
    throw new ConfigError(`${name} 格式应为 "基本秒,读秒次数,每次秒"（如 600,3,30），当前为 "${raw}"`);
  }
  const [mainSec, periods, periodSec] = parts.map(Number);
  if (mainSec > 86400) throw new ConfigError(`${name} 基本时间不能超过 86400 秒`);
  if (periods > 100) throw new ConfigError(`${name} 读秒次数不能超过 100`);
  if (periodSec > 3600) throw new ConfigError(`${name} 每次读秒不能超过 3600 秒`);
  if (periods > 0 && periodSec < 1) throw new ConfigError(`${name} 有读秒次数时每次读秒至少 1 秒`);
  if (mainSec === 0 && periods === 0) throw new ConfigError(`${name} 基本时间与读秒不能同时为 0`);
  return { mainMs: mainSec * 1000, periods, periodMs: periodSec * 1000 };
}

function parsePublicBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL 不是合法的地址："${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ConfigError(`PUBLIC_BASE_URL 必须以 http:// 或 https:// 开头："${raw}"`);
  }
  if (u.search || u.hash) throw new ConfigError('PUBLIC_BASE_URL 不能带查询参数或 #');
  // 去掉结尾的 /，拼接时统一写 base + '/avatars/...'
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

// 内容安全检测（微信 msgSecCheck / imgSecCheck）：off 关闭；on 检测，微信接口出错时放行；strict 出错也拒绝
const SEC_CHECK_MODES = ['off', 'on', 'strict'];
function parseSecCheck(env) {
  const raw = str(env, 'SEC_CHECK').toLowerCase();
  if (!raw) return 'on';
  if (raw === '0' || raw === 'false') return 'off';
  if (raw === '1' || raw === 'true') return 'on';
  if (SEC_CHECK_MODES.includes(raw)) return raw;
  throw new ConfigError(`SEC_CHECK 只能是 off / on / strict，当前为 "${env.SEC_CHECK}"`);
}

// 开发登录谁都能用任意设备号登录，只能用于本地开发：正式环境（NODE_ENV=production 或对外地址是 https）拒绝启动，
// 除非明确设置 DEV_LOGIN_ALLOW_PRODUCTION=1（例如临时的测试服）
function checkDevLogin(env, devLogin, publicBaseUrl) {
  if (!devLogin || parseBoolVar(env, 'DEV_LOGIN_ALLOW_PRODUCTION', false)) return;
  const production = str(env, 'NODE_ENV').toLowerCase() === 'production';
  if (production || publicBaseUrl.startsWith('https:')) {
    throw new ConfigError(
      'DEV_LOGIN=1 不能用于正式环境（NODE_ENV=production 或 PUBLIC_BASE_URL 是 https）；' +
        '确实需要请同时设置 DEV_LOGIN_ALLOW_PRODUCTION=1',
    );
  }
}

// 文件路径相对 server/ 解析
function resolvePath(p) {
  return path.resolve(SERVER_ROOT, p);
}

// 可执行文件：不含路径分隔符的裸命令名（如 "katago"）保留原样，交给 PATH 查找
function resolveExecutable(p) {
  if (path.isAbsolute(p) || /[\\/]/.test(p)) return resolvePath(p);
  return p;
}

function buildConfig(env) {
  const dataDir = resolvePath(str(env, 'DATA_DIR') || DEFAULTS.dataDir);

  const katagoPath = str(env, 'KATAGO_PATH');
  const katagoModel = str(env, 'KATAGO_MODEL');
  const katagoConfig = str(env, 'KATAGO_CONFIG') || DEFAULTS.katagoConfig;
  const katago =
    katagoPath && katagoModel && katagoConfig
      ? { path: resolveExecutable(katagoPath), model: resolvePath(katagoModel), config: resolvePath(katagoConfig) }
      : null;

  const timeControls = {};
  for (const size of [9, 13, 19]) {
    const raw = str(env, `TC_${size}`);
    timeControls[size] = raw ? parseTimeControl(raw, `TC_${size}`) : { ...DEFAULT_TIME_CONTROLS[size] };
  }

  const publicBaseUrl = parsePublicBaseUrl(str(env, 'PUBLIC_BASE_URL') || DEFAULTS.publicBaseUrl);
  const devLogin = parseBoolVar(env, 'DEV_LOGIN', false);
  checkDevLogin(env, devLogin, publicBaseUrl);

  return {
    port: parseIntVar(env, 'PORT', DEFAULTS.port, { min: 0, max: 65535 }),
    host: str(env, 'HOST') || DEFAULTS.host,
    publicBaseUrl,
    dataDir,
    dbPath: path.join(dataDir, 'gamego.db'),
    avatarDir: path.join(dataDir, 'avatars'),
    wx: { appId: str(env, 'WX_APPID'), secret: str(env, 'WX_SECRET') },
    devLogin,
    secCheck: parseSecCheck(env),
    katago,
    aiFallback: parseBoolVar(env, 'AI_FALLBACK', false),
    komi: DEFAULTS.komi,
    timeControls,
    minMovesRanked: parseIntVar(env, 'MIN_MOVES_RANKED', DEFAULTS.minMovesRanked, { min: 0, max: 1000 }),
    minGamesWinrate: parseIntVar(env, 'MIN_GAMES_WINRATE', DEFAULTS.minGamesWinrate, { min: 1, max: 100000 }),
    // 同一对手 24 小时内最多计入排行的局数（0 = 不限），防两个账号互刷连胜
    rankedPairDailyMax: parseIntVar(env, 'RANKED_PAIR_DAILY_MAX', DEFAULTS.rankedPairDailyMax, { min: 0, max: 1000 }),
    firstMoveTimeoutMs: DEFAULTS.firstMoveTimeoutMs,
    abandonMs: DEFAULTS.abandonMs,
    scoringTimeoutMs: DEFAULTS.scoringTimeoutMs,
    judgeTimeoutMs: DEFAULTS.judgeTimeoutMs,
    aiIdleTimeoutMs: DEFAULTS.aiIdleTimeoutMs,
    roomTtlMs: DEFAULTS.roomTtlMs,
  };
}

// 读取 env 文件。env 就是 process.env 时用 process.loadEnvFile（不覆盖已有的环境变量）；
// 传入的是普通对象时（测试）解析文件后合并，同样以已有值为准，不修改 process.env。
function applyEnvFile(env, envFile) {
  if (!envFile || !fs.existsSync(envFile)) return env;
  if (env === process.env) {
    process.loadEnvFile(envFile);
    return env;
  }
  const parsed = util.parseEnv(fs.readFileSync(envFile, 'utf8'));
  return { ...parsed, ...env };
}

// options.envFile：默认只有在读 process.env 时才读取 server/.env；传 null 表示不读
function loadConfig(env = process.env, options = {}) {
  const envFile = 'envFile' in options ? options.envFile : env === process.env ? DEFAULT_ENV_FILE : null;
  return buildConfig(applyEnvFile(env, envFile));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 测试用：全部默认值 + 覆盖。与 loadConfig({}) 的区别只有一处：
// dbPath 默认为 ':memory:'，避免测试误写 server/data/gamego.db。
// 覆盖了 dataDir 而没有覆盖 avatarDir 时，avatarDir 随 dataDir 走。
// wx 与 timeControls 按键合并（只覆盖给出的字段）。
function defaultConfig(overrides = {}) {
  const base = buildConfig({});
  const cfg = { ...base, ...overrides };
  if (overrides.dataDir !== undefined) cfg.dataDir = resolvePath(overrides.dataDir);
  if (overrides.dbPath === undefined) cfg.dbPath = ':memory:';
  if (overrides.avatarDir === undefined) cfg.avatarDir = path.join(cfg.dataDir, 'avatars');
  if (isPlainObject(overrides.wx)) cfg.wx = { ...base.wx, ...overrides.wx };
  if (isPlainObject(overrides.timeControls)) cfg.timeControls = { ...base.timeControls, ...overrides.timeControls };
  return cfg;
}

// 启动时创建数据目录与头像目录；内存数据库不需要数据库目录
function ensureDirs(config) {
  fs.mkdirSync(config.avatarDir, { recursive: true });
  if (config.dbPath && config.dbPath !== ':memory:' && !config.dbPath.startsWith('file:')) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
}

module.exports = {
  loadConfig,
  defaultConfig,
  ensureDirs,
  parseTimeControl,
  ConfigError,
  SERVER_ROOT,
  DEFAULT_ENV_FILE,
  DEFAULT_TIME_CONTROLS,
};
