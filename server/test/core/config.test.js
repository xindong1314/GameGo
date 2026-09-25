'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadConfig,
  defaultConfig,
  ensureDirs,
  parseTimeControl,
  SERVER_ROOT,
  ConfigError,
} = require('../../src/config');
const { tmpDir, rmDir } = require('./helpers');

const load = (env) => loadConfig(env, { envFile: null });

test('loadConfig：默认值与第 2.5 节的 Config 结构一致', () => {
  const c = load({});
  assert.deepEqual(Object.keys(c).sort(), [
    'abandonMs',
    'aiFallback',
    'aiIdleTimeoutMs',
    'avatarDir',
    'dataDir',
    'dbPath',
    'devLogin',
    'firstMoveTimeoutMs',
    'host',
    'judgeTimeoutMs',
    'katago',
    'komi',
    'minGamesWinrate',
    'minMovesRanked',
    'port',
    'publicBaseUrl',
    'rankedPairDailyMax',
    'roomTtlMs',
    'scoringTimeoutMs',
    'secCheck',
    'timeControls',
    'wx',
  ]);
  assert.equal(c.port, 8080);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.publicBaseUrl, 'http://localhost:8080');
  assert.equal(c.dataDir, path.join(SERVER_ROOT, 'data'));
  assert.equal(c.dbPath, path.join(SERVER_ROOT, 'data', 'gamego.db'));
  assert.equal(c.avatarDir, path.join(SERVER_ROOT, 'data', 'avatars'));
  assert.deepEqual(c.wx, { appId: '', secret: '' });
  assert.equal(c.devLogin, false);
  assert.equal(c.secCheck, 'on');
  assert.equal(c.katago, null);
  assert.equal(c.aiFallback, false);
  assert.equal(c.komi, 7.5);
  assert.deepEqual(c.timeControls, {
    9: { mainMs: 180000, periods: 3, periodMs: 20000 },
    13: { mainMs: 360000, periods: 3, periodMs: 30000 },
    19: { mainMs: 600000, periods: 3, periodMs: 30000 },
  });
  assert.equal(c.minMovesRanked, 10);
  assert.equal(c.minGamesWinrate, 10);
  assert.equal(c.rankedPairDailyMax, 3);
  assert.equal(c.firstMoveTimeoutMs, 60000);
  assert.equal(c.abandonMs, 90000);
  assert.equal(c.scoringTimeoutMs, 180000);
  assert.equal(c.judgeTimeoutMs, 15000);
  assert.equal(c.aiIdleTimeoutMs, 86400000);
  assert.equal(c.roomTtlMs, 1800000);
});

test('loadConfig：读取各环境变量', () => {
  const abs = path.resolve(tmpDir(), 'd');
  const c = load({
    PORT: '9000',
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: 'https://go.example.com/',
    DATA_DIR: abs,
    WX_APPID: ' wx123 ',
    WX_SECRET: 'sec',
    DEV_LOGIN: '1',
    DEV_LOGIN_ALLOW_PRODUCTION: '1', // 对外地址是 https：必须明确允许才能开开发登录
    SEC_CHECK: 'strict',
    AI_FALLBACK: 'true',
    TC_9: '60,5,10',
    TC_13: ' 0 , 3 , 30 ',
    TC_19: '1200,0,0',
    MIN_MOVES_RANKED: '0',
    MIN_GAMES_WINRATE: '3',
    RANKED_PAIR_DAILY_MAX: '0',
  });
  assert.equal(c.port, 9000);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.publicBaseUrl, 'https://go.example.com');
  assert.equal(c.dataDir, abs);
  assert.equal(c.dbPath, path.join(abs, 'gamego.db'));
  assert.equal(c.avatarDir, path.join(abs, 'avatars'));
  assert.deepEqual(c.wx, { appId: 'wx123', secret: 'sec' });
  assert.equal(c.devLogin, true);
  assert.equal(c.secCheck, 'strict');
  assert.equal(c.aiFallback, true);
  assert.deepEqual(c.timeControls[9], { mainMs: 60000, periods: 5, periodMs: 10000 });
  assert.deepEqual(c.timeControls[13], { mainMs: 0, periods: 3, periodMs: 30000 });
  assert.deepEqual(c.timeControls[19], { mainMs: 1200000, periods: 0, periodMs: 0 });
  assert.equal(c.minMovesRanked, 0);
  assert.equal(c.minGamesWinrate, 3);
  assert.equal(c.rankedPairDailyMax, 0, '0 = 同一对手不限局数');
  rmDir(path.dirname(abs));
});

test('loadConfig：相对路径相对 server/ 目录解析，空值视为未设置', () => {
  const c = load({ DATA_DIR: 'var/db', PORT: '', HOST: '  ', DEV_LOGIN: '' });
  assert.equal(c.dataDir, path.join(SERVER_ROOT, 'var', 'db'));
  assert.equal(c.port, 8080);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.devLogin, false);
  assert.equal(load({ PUBLIC_BASE_URL: 'https://a.com/sub/' }).publicBaseUrl, 'https://a.com/sub');
  assert.equal(load({ PORT: '0' }).port, 0);
});

test('loadConfig：KataGo 三项都有才启用（KATAGO_CONFIG 有默认值）', () => {
  assert.equal(load({ KATAGO_PATH: '/opt/katago/katago' }).katago, null);
  assert.equal(load({ KATAGO_MODEL: '/opt/katago/m.bin.gz' }).katago, null);
  const c = load({ KATAGO_PATH: '/opt/katago/katago', KATAGO_MODEL: 'katago/m.bin.gz' });
  assert.deepEqual(c.katago, {
    path: path.resolve('/opt/katago/katago'),
    model: path.join(SERVER_ROOT, 'katago', 'm.bin.gz'),
    config: path.join(SERVER_ROOT, 'katago', 'analysis.cfg'),
  });
  // KATAGO_CONFIG 留空 = 使用默认
  assert.equal(
    load({ KATAGO_PATH: 'x/katago', KATAGO_MODEL: 'm', KATAGO_CONFIG: '' }).katago.config,
    path.join(SERVER_ROOT, 'katago', 'analysis.cfg'),
  );
  // 裸命令名交给 PATH 查找，不做解析
  assert.equal(load({ KATAGO_PATH: 'katago', KATAGO_MODEL: 'm' }).katago.path, 'katago');
  assert.equal(load({ KATAGO_PATH: './katago/katago', KATAGO_MODEL: 'm' }).katago.path, path.join(SERVER_ROOT, 'katago', 'katago'));
  assert.equal(load({ KATAGO_PATH: 'a', KATAGO_MODEL: 'm', KATAGO_CONFIG: '/etc/k.cfg' }).katago.config, path.resolve('/etc/k.cfg'));
});

test('loadConfig：非法取值抛 ConfigError', () => {
  const bad = [
    { PORT: 'abc' },
    { PORT: '70000' },
    { PORT: '-1' },
    { PORT: '80.5' },
    { DEV_LOGIN: 'maybe' },
    { AI_FALLBACK: '2' },
    { PUBLIC_BASE_URL: 'go.example.com' },
    { PUBLIC_BASE_URL: 'ftp://go.example.com' },
    { PUBLIC_BASE_URL: 'https://go.example.com/?a=1' },
    { MIN_MOVES_RANKED: '-3' },
    { MIN_GAMES_WINRATE: '0' },
    { MIN_GAMES_WINRATE: 'ten' },
    { RANKED_PAIR_DAILY_MAX: '-1' },
    { TC_9: '600,3' },
    { TC_9: '600,3,30,1' },
    { TC_13: 'a,b,c' },
    { TC_19: '600,-3,30' },
    { TC_19: '600,3,0' },
    { TC_9: '0,0,0' },
    { TC_9: '1.5,3,30' },
    { TC_9: '100000,3,30' },
    { SEC_CHECK: 'maybe' },
  ];
  for (const env of bad) {
    assert.throws(() => load(env), ConfigError, JSON.stringify(env));
  }
});

test('DEV_LOGIN：正式环境（NODE_ENV=production 或 https 对外地址）拒绝启动，除非 DEV_LOGIN_ALLOW_PRODUCTION=1', () => {
  assert.throws(() => load({ DEV_LOGIN: '1', NODE_ENV: 'production' }), /DEV_LOGIN_ALLOW_PRODUCTION/);
  assert.throws(() => load({ DEV_LOGIN: '1', PUBLIC_BASE_URL: 'https://go.example.com' }), ConfigError);
  assert.equal(load({ DEV_LOGIN: '1', NODE_ENV: 'production', DEV_LOGIN_ALLOW_PRODUCTION: '1' }).devLogin, true);
  // 本地开发：http 局域网地址、非 production
  assert.equal(load({ DEV_LOGIN: '1', PUBLIC_BASE_URL: 'http://192.168.1.100:8080' }).devLogin, true);
  // 不开开发登录时与这些设置无关
  assert.equal(load({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://go.example.com' }).devLogin, false);
});

test('SEC_CHECK：off / on / strict（也接受 0 / 1），默认 on', () => {
  assert.equal(load({}).secCheck, 'on');
  assert.equal(load({ SEC_CHECK: 'OFF' }).secCheck, 'off');
  assert.equal(load({ SEC_CHECK: '0' }).secCheck, 'off');
  assert.equal(load({ SEC_CHECK: '1' }).secCheck, 'on');
  assert.equal(load({ SEC_CHECK: 'strict' }).secCheck, 'strict');
});

test('布尔变量接受 1/0/true/false/yes/no/on/off', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(load({ DEV_LOGIN: v }).devLogin, true, v);
  for (const v of ['0', 'false', 'no', 'off']) assert.equal(load({ DEV_LOGIN: v }).devLogin, false, v);
});

test('parseTimeControl', () => {
  assert.deepEqual(parseTimeControl('600,3,30', 'TC'), { mainMs: 600000, periods: 3, periodMs: 30000 });
  assert.deepEqual(parseTimeControl('0,5,10', 'TC'), { mainMs: 0, periods: 5, periodMs: 10000 });
  assert.throws(() => parseTimeControl('', 'TC'), /TC/);
});

test('loadConfig：读取 env 文件，已有的环境变量优先，文件不存在不报错', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# 注释\nPORT=9100\nWX_APPID=fromfile\nDEV_LOGIN=1\nTC_9="120,3,10"\n');
  const c = loadConfig({ WX_APPID: 'fromenv' }, { envFile: file });
  assert.equal(c.port, 9100);
  assert.equal(c.wx.appId, 'fromenv');
  assert.equal(c.devLogin, true);
  assert.deepEqual(c.timeControls[9], { mainMs: 120000, periods: 3, periodMs: 10000 });
  // 文件不存在
  assert.equal(loadConfig({}, { envFile: path.join(dir, 'nope.env') }).port, 8080);
  // 传入普通对象且未指定 envFile 时不读任何文件
  assert.equal(loadConfig({}).port, 8080);
  rmDir(dir);
});

test('loadConfig(process.env)：用 process.loadEnvFile 读入且不覆盖已有变量', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.env');
  const key = `GAMEGO_TEST_${process.pid}`;
  fs.writeFileSync(file, `${key}=fromfile\nMIN_GAMES_WINRATE_UNUSED=1\n`);
  const saved = { ...process.env };
  try {
    delete process.env.PORT;
    process.env.MIN_GAMES_WINRATE_UNUSED = 'keep';
    loadConfig(process.env, { envFile: file });
    assert.equal(process.env[key], 'fromfile');
    assert.equal(process.env.MIN_GAMES_WINRATE_UNUSED, 'keep');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmDir(dir);
  }
});

test('defaultConfig：默认内存数据库，按键合并 wx 与 timeControls', () => {
  const c = defaultConfig();
  assert.equal(c.dbPath, ':memory:');
  assert.equal(c.port, 8080);
  assert.equal(c.avatarDir, path.join(SERVER_ROOT, 'data', 'avatars'));

  const d = defaultConfig({
    port: 0,
    dataDir: '/tmp/x',
    wx: { appId: 'a' },
    timeControls: { 9: { mainMs: 1000, periods: 1, periodMs: 1000 } },
    devLogin: true,
  });
  assert.equal(d.port, 0);
  assert.equal(d.dataDir, path.resolve('/tmp/x'));
  assert.equal(d.avatarDir, path.join(path.resolve('/tmp/x'), 'avatars'));
  assert.equal(d.dbPath, ':memory:');
  assert.deepEqual(d.wx, { appId: 'a', secret: '' });
  assert.deepEqual(d.timeControls[9], { mainMs: 1000, periods: 1, periodMs: 1000 });
  assert.deepEqual(d.timeControls[19], { mainMs: 600000, periods: 3, periodMs: 30000 });
  assert.equal(d.devLogin, true);
  assert.equal(defaultConfig({ dbPath: '/x/y.db' }).dbPath, '/x/y.db');
  assert.equal(defaultConfig({ katago: null }).katago, null);
  // 不同调用互不影响
  defaultConfig().timeControls[9].mainMs = 1;
  assert.equal(defaultConfig().timeControls[9].mainMs, 180000);
});

test('ensureDirs：创建头像目录与数据库目录，内存数据库只建头像目录', () => {
  const dir = tmpDir();
  const cfg = defaultConfig({ dataDir: path.join(dir, 'data'), dbPath: path.join(dir, 'db', 'x.db') });
  ensureDirs(cfg);
  assert.ok(fs.statSync(path.join(dir, 'data', 'avatars')).isDirectory());
  assert.ok(fs.statSync(path.join(dir, 'db')).isDirectory());
  const mem = defaultConfig({ dataDir: path.join(dir, 'mem') });
  ensureDirs(mem);
  assert.ok(fs.statSync(path.join(dir, 'mem', 'avatars')).isDirectory());
  ensureDirs(mem); // 再次调用不报错
  rmDir(dir);
});
