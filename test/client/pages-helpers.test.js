'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PAGES = path.join(__dirname, '..', '..', 'miniprogram', 'pages');
const home = require(path.join(PAGES, 'index', 'home'));
const { parseKomi } = require(path.join(PAGES, 'local', 'komi'));
const nick = require(path.join(PAGES, 'profile', 'nickname'));
const waiting = require(path.join(PAGES, 'match', 'waiting'));
const rs = require(path.join(PAGES, 'room', 'room-state'));
const lv = require(path.join(PAGES, 'ai', 'levels'));
const rows = require(path.join(PAGES, 'leaderboard', 'rows'));
const history = require(path.join(PAGES, 'me', 'history'));

// ---------- 首页 ----------

test('home.normalizeSize：只接受 9/13/19，其余用回退值', () => {
  assert.equal(home.normalizeSize('9'), 9);
  assert.equal(home.normalizeSize(13), 13);
  assert.equal(home.normalizeSize('19', 9), 19);
  assert.equal(home.normalizeSize('15', 9), 9);
  assert.equal(home.normalizeSize(undefined, 13), 13);
  assert.equal(home.normalizeSize('abc'), 19);
  assert.equal(home.normalizeSize('', 7), 19, '非法回退值也回到 19');
});

test('home.normalizeRoomColor / 地址生成', () => {
  assert.equal(home.normalizeRoomColor('black'), 'black');
  assert.equal(home.normalizeRoomColor('white'), 'white');
  assert.equal(home.normalizeRoomColor('green'), 'random');
  assert.equal(home.matchUrl(13), '/pages/match/match?size=13');
  assert.equal(home.matchUrl('bad'), '/pages/match/match?size=19');
  assert.equal(home.roomCreateUrl(9, 'white'), '/pages/room/room?create=1&size=9&color=white');
  assert.equal(home.roomCreateUrl(21, 'x'), '/pages/room/room?create=1&size=19&color=random');
  assert.equal(home.playUrl('abc123'), '/pages/play/play?id=abc123');
});

test('home.isGameId', () => {
  assert.equal(home.isGameId('a1b2c3d4e5f6'), true);
  assert.equal(home.isGameId(''), false);
  assert.equal(home.isGameId(123), false);
  assert.equal(home.isGameId('a b'), false);
  assert.equal(home.isGameId('x'.repeat(65)), false);
});

test('home.bannersFromHello：真人对局排前，其次房间、匹配', () => {
  const banners = home.bannersFromHello({
    activeGames: [{ id: 'aigame000001', mode: 'ai' }, { id: 'ranked000001', mode: 'ranked' }],
    room: { code: '123456', status: 'waiting' },
    matching: { size: 13 },
  });
  assert.deepEqual(banners.map((b) => b.kind), ['game', 'game', 'room', 'match']);
  assert.equal(banners[0].url, '/pages/play/play?id=ranked000001');
  assert.match(banners[0].text, /排位赛/);
  assert.match(banners[1].text, /人机对局/);
  assert.equal(banners[2].url, '/pages/room/room?code=123456');
  assert.equal(banners[3].url, '/pages/match/match?size=13');
  assert.equal(new Set(banners.map((b) => b.key)).size, 4, 'key 唯一');
});

test('home.bannersFromHello：忽略非法与已关闭的数据', () => {
  assert.deepEqual(home.bannersFromHello(null), []);
  assert.deepEqual(home.bannersFromHello('x'), []);
  assert.deepEqual(home.bannersFromHello({ activeGames: 'nope', room: null, matching: null }), []);
  const b = home.bannersFromHello({
    activeGames: [null, { id: '' }, { id: 'ok0000000001', mode: 'weird' }],
    room: { code: '12345', status: 'waiting' },
    matching: { size: 15 },
  });
  assert.equal(b.length, 1);
  assert.match(b[0].text, /你有一局对局正在进行/);
  assert.deepEqual(home.bannersFromHello({ room: { code: '123456', status: 'closed' } }), []);
});

test('home.userView', () => {
  assert.equal(home.userView(null), null);
  assert.deepEqual(home.userView({ id: 3, nickname: '甲', avatarUrl: 'http://a/b.png', openid: 'x' }),
    { id: 3, nickname: '甲', avatarUrl: 'http://a/b.png' });
  assert.deepEqual(home.userView({ id: 3 }), { id: 3, nickname: '', avatarUrl: '' });
});

// ---------- 本地对弈 ----------

test('parseKomi：只收非负十进制数', () => {
  assert.deepEqual(parseKomi('7.5'), { ok: true, value: 7.5 });
  assert.deepEqual(parseKomi(' 6 '), { ok: true, value: 6 });
  assert.deepEqual(parseKomi(0), { ok: true, value: 0 });
  assert.equal(parseKomi('').ok, false);
  assert.equal(parseKomi('-1').ok, false);
  assert.equal(parseKomi('7.').ok, false);
  assert.equal(parseKomi('abc').ok, false);
  assert.equal(parseKomi(null).ok, false);
  assert.equal(parseKomi('abc').msg, '贴目请输入数字');
  for (const bad of ['.5', '7.5.1', '1e2', '+3', '0x1', '7 .5', '６']) assert.equal(parseKomi(bad).ok, false, bad);
  assert.deepEqual(parseKomi('0.25'), { ok: true, value: 0.25 });
  assert.deepEqual(parseKomi('12'), { ok: true, value: 12 });
});

// ---------- 资料 ----------

test('validateNickname：去首尾空白，1~16 个字', () => {
  assert.deepEqual(nick.validateNickname('  棋手  '), { ok: true, value: '棋手' });
  assert.equal(nick.validateNickname('').ok, false);
  assert.equal(nick.validateNickname('   ').msg, '请输入昵称');
  assert.equal(nick.validateNickname(undefined).ok, false);
  assert.equal(nick.validateNickname('一二三四五六七八九十一二三四五六').ok, true);
  const long = nick.validateNickname('一二三四五六七八九十一二三四五六七');
  assert.equal(long.ok, false);
  assert.match(long.msg, /16/);
});

test('validateNickname：emoji 按一个字计，拒绝控制字符', () => {
  assert.equal(nick.nicknameLength('😀😀'), 2);
  assert.equal(nick.validateNickname('😀'.repeat(16)).ok, true);
  assert.equal(nick.validateNickname('😀'.repeat(17)).ok, false);
  assert.equal(nick.validateNickname('a\u0007b').ok, false);
  assert.equal(nick.validateNickname('a\nb').ok, false);
  assert.equal(nick.validateNickname('a\u0085b').ok, false);
});

test('validateNickname：与服务端一致，拒绝零宽空格、行分隔符、双向控制符、BOM 与落单的代理项', () => {
  for (const bad of ['棋手\u200b小王', 'a\u2028b', 'a\u2029b', 'a\u202eb', 'a\u2066b', 'a\ufeffb']) {
    const r = nick.validateNickname(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.msg, '昵称含有不可见的特殊字符');
  }
  assert.equal(nick.validateNickname('a\ud83db').msg, '昵称包含无效字符');
  assert.equal(nick.validateNickname('a\ude00b').msg, '昵称包含无效字符');
  // 首尾的 BOM 会被 trim 掉（服务端同样先 trim）
  assert.deepEqual(nick.validateNickname('\ufeff小王'), { ok: true, value: '小王' });
  // 零宽连接符用于组合 emoji，允许
  assert.equal(nick.validateNickname('👨\u200d👩\u200d👧').ok, true);
  assert.equal(nick.isForbiddenCodePoint(0x200d), false);
});

test('resolveRedirect：兼容已解码/未解码，拒绝外部与自身地址', () => {
  const url = '/pages/room/room?create=1&size=9&color=black';
  assert.equal(nick.resolveRedirect(url), url);
  assert.equal(nick.resolveRedirect(encodeURIComponent(url)), url);
  assert.equal(nick.resolveRedirect(encodeURIComponent(encodeURIComponent(url))), url);
  assert.equal(nick.resolveRedirect('/pages/match/match?size=19'), '/pages/match/match?size=19');
  assert.equal(nick.resolveRedirect('/pages/ai/ai'), '/pages/ai/ai');
  assert.equal(nick.resolveRedirect('https://evil.example.com/'), '');
  assert.equal(nick.resolveRedirect('pages/ai/ai'), '');
  assert.equal(nick.resolveRedirect('/pages/profile/profile?redirect=x'), '');
  assert.equal(nick.resolveRedirect('/pages/../x/y'), '');
  assert.equal(nick.resolveRedirect('%E0%A4%A'), '');
  assert.equal(nick.resolveRedirect(undefined), '');
  assert.equal(nick.resolveRedirect(42), '');
});

test('planSave：只在需要时上传头像 / 提交昵称', () => {
  assert.deepEqual(nick.planSave({ avatarChanged: false, nickname: '甲', currentNickname: '' }), { upload: false, nickname: true });
  assert.deepEqual(nick.planSave({ avatarChanged: true, nickname: '甲', currentNickname: '甲' }), { upload: true, nickname: false });
  assert.deepEqual(nick.planSave({ avatarChanged: false, nickname: '乙', currentNickname: '甲' }), { upload: false, nickname: true });
  assert.deepEqual(nick.planSave({ avatarChanged: false, nickname: '甲', currentNickname: '甲' }), { upload: false, nickname: false });
});

// ---------- 匹配 ----------

test('匹配计时', () => {
  assert.equal(waiting.elapsedSeconds(1000, 1000), 0);
  assert.equal(waiting.elapsedSeconds(1000, 2999), 1);
  assert.equal(waiting.elapsedSeconds(5000, 1000), 0, '时钟回拨不出现负数');
  assert.equal(waiting.elapsedSeconds(NaN, 1000), 0);
  assert.equal(waiting.formatElapsed(0), '0:00');
  assert.equal(waiting.formatElapsed(9), '0:09');
  assert.equal(waiting.formatElapsed(65), '1:05');
  assert.equal(waiting.formatElapsed(3725), '1:02:05');
  assert.equal(waiting.formatElapsed(-3), '0:00');
  assert.equal(waiting.AI_HINT_SEC, 60);
});

test('findActiveGame 按模式优先级查找', () => {
  const games = [{ id: 'ai0000000001', mode: 'ai' }, { id: 'fr0000000001', mode: 'friend' }, { id: 'rk0000000001', mode: 'ranked' }];
  assert.equal(waiting.findActiveGame(games, ['ranked', 'friend']).id, 'rk0000000001');
  assert.equal(waiting.findActiveGame(games, ['friend']).id, 'fr0000000001');
  assert.equal(waiting.findActiveGame([{ id: 'ai0000000001', mode: 'ai' }], ['ranked']), null);
  assert.equal(waiting.findActiveGame(null, ['ranked']), null);
  assert.equal(waiting.findActiveGame([{ id: 5, mode: 'ranked' }], ['ranked']), null);
});

// ---------- 好友房 ----------

test('房号校验与输入清洗', () => {
  assert.equal(rs.normalizeCode('123456'), '123456');
  assert.equal(rs.normalizeCode(' 123 456 '), '123456');
  assert.equal(rs.normalizeCode(123456), '123456');
  assert.equal(rs.normalizeCode('12345'), '');
  assert.equal(rs.normalizeCode('1234567'), '');
  assert.equal(rs.normalizeCode('12345a'), '');
  assert.equal(rs.normalizeCode(null), '');
  assert.equal(rs.sanitizeCodeInput('12a3 45678'), '123456');
  assert.equal(rs.sanitizeCodeInput(undefined), '');
});

test('parseRoomQuery：创建 / 受邀 / 手动输入', () => {
  assert.deepEqual(rs.parseRoomQuery({ create: '1', size: '9', color: 'white' }), { mode: 'create', size: 9, color: 'white' });
  assert.deepEqual(rs.parseRoomQuery({ create: 'true', size: '21', color: 'pink' }), { mode: 'create', size: 19, color: 'random' });
  assert.deepEqual(rs.parseRoomQuery({ code: '654321' }), { mode: 'invite', code: '654321' });
  assert.deepEqual(rs.parseRoomQuery({ code: '65432' }), { mode: 'entry', invalidCode: true });
  assert.deepEqual(rs.parseRoomQuery({}), { mode: 'entry', invalidCode: false });
  assert.deepEqual(rs.parseRoomQuery(undefined), { mode: 'entry', invalidCode: false });
  assert.deepEqual(rs.parseRoomQuery({ create: '0', code: '111111' }), { mode: 'invite', code: '111111' });
});

const ROOM = {
  code: '246810',
  owner: { userId: 7, nickname: '老王', avatarUrl: 'http://x/a.png' },
  size: 13,
  color: 'black',
  status: 'waiting',
  expiresIn: 1800000,
};

test('isRoom 校验契约里的 Room', () => {
  assert.equal(rs.isRoom(ROOM), true);
  assert.equal(rs.isRoom(null), false);
  assert.equal(rs.isRoom({ ...ROOM, code: '12' }), false);
  assert.equal(rs.isRoom({ ...ROOM, owner: null }), false);
  assert.equal(rs.isRoom({ ...ROOM, size: 15 }), false);
});

test('colorText / roomView：从双方视角描述执子', () => {
  assert.equal(rs.colorText('black', true), '你执黑先行');
  assert.equal(rs.colorText('black', false), '你执白');
  assert.equal(rs.colorText('white', true), '你执白');
  assert.equal(rs.colorText('white', false), '你执黑先行');
  assert.equal(rs.colorText('random', false), '黑白随机分配');
  const v = rs.roomView(ROOM, false);
  assert.deepEqual(v.digits.map((x) => x.d), ['2', '4', '6', '8', '1', '0']);
  assert.deepEqual(v.digits.map((x) => x.i), [0, 1, 2, 3, 4, 5]);
  assert.equal(v.sizeText, '13 路');
  assert.equal(v.ownerName, '老王');
  assert.equal(v.ownerAvatar, 'http://x/a.png');
  assert.equal(v.colorText, '你执白');
  assert.equal(rs.roomView({ ...ROOM, owner: { userId: 7, nickname: '' } }, true).ownerName, '棋友');
});

test('formatRemain', () => {
  assert.equal(rs.formatRemain(1800000), '30:00');
  assert.equal(rs.formatRemain(61000), '01:01');
  assert.equal(rs.formatRemain(500), '00:01');
  assert.equal(rs.formatRemain(0), '00:00');
  assert.equal(rs.formatRemain(-100), '00:00');
  assert.equal(rs.formatRemain(NaN), '00:00');
});

test('shareMessage：标题带昵称与路数，路径带房号', () => {
  assert.deepEqual(rs.shareMessage(ROOM), { title: '老王 邀你下一盘围棋（13路）', path: '/pages/room/room?code=246810' });
  assert.equal(rs.shareMessage({ ...ROOM, owner: { nickname: '' } }).title, '好友 邀你下一盘围棋（13路）');
});

// ---------- 人机 ----------

test('normalizeLevels：过滤不完整条目，available 需有难度', () => {
  const r = lv.normalizeLevels({
    available: true,
    levels: [{ id: 'k1', name: '入门', desc: '刚学会规则' }, { id: 'k1', name: '重复' }, null, { name: '无 id' }, { id: 5 }],
  });
  assert.equal(r.available, true);
  assert.deepEqual(r.levels, [{ id: 'k1', name: '入门', desc: '刚学会规则' }, { id: '5', name: '5', desc: '' }]);
  assert.equal(lv.normalizeLevels({ available: true, levels: [] }).available, false);
  assert.equal(lv.normalizeLevels({ available: false, levels: [{ id: 'a', name: 'A' }] }).available, false);
  assert.deepEqual(lv.normalizeLevels(null), { available: false, levels: [] });
});

test('pickLevel / normalizeSettings', () => {
  const levels = [{ id: 'a' }, { id: 'b' }];
  assert.equal(lv.pickLevel(levels, 'b'), 'b');
  assert.equal(lv.pickLevel(levels, 'zzz'), 'a');
  assert.equal(lv.pickLevel(levels), 'a');
  assert.equal(lv.pickLevel([], 'a'), '');
  assert.deepEqual(lv.normalizeSettings({ size: 9, level: 'b', color: 'white' }), { size: 9, level: 'b', color: 'white' });
  assert.deepEqual(lv.normalizeSettings('garbage'), { size: 19, level: '', color: 'random' });
  assert.deepEqual(lv.normalizeSettings({ size: 10, level: 3, color: 'x' }), { size: 19, level: '', color: 'random' });
  assert.equal(lv.isColor('black'), true);
  assert.equal(lv.isColor('blue'), false);
});

// ---------- 排行榜 ----------

test('formatPercent / formatValue', () => {
  assert.equal(rows.formatPercent(0.623), '62.3%');
  assert.equal(rows.formatPercent(0.5), '50%');
  assert.equal(rows.formatPercent(1), '100%');
  assert.equal(rows.formatPercent(0), '0%');
  assert.equal(rows.formatPercent(2), '100%');
  assert.equal(rows.formatPercent('x'), '0%');
  assert.equal(rows.formatPercent(0.66666), '66.7%');
  assert.equal(rows.formatValue('streak', 5), '5 连胜');
  assert.equal(rows.formatValue('maxStreak', '12'), '12 连胜');
  assert.equal(rows.formatValue('winrate', 0.7), '70%');
  assert.equal(rows.formatValue('streak', -1), '0 连胜');
});

test('formatRows：名次、奖牌、自己高亮、兼容嵌套 user', () => {
  const items = [
    { rank: 1, userId: 5, nickname: '甲', avatarUrl: 'a', value: 8, games: 20, wins: 15 },
    { rank: 2, userId: 1, nickname: '乙', avatarUrl: '', value: 6, games: 9, wins: 7 },
    { rank: 3, user: { id: 9, nickname: '丙', avatarUrl: 'c' }, value: 4 },
    { rank: 4, userId: 2, nickname: '', value: 3 },
    null,
  ];
  const r = rows.formatRows('streak', items, 1);
  assert.equal(r.length, 4);
  assert.deepEqual(r.map((x) => x.medal), ['gold', 'silver', 'bronze', '']);
  assert.deepEqual(r.map((x) => x.isMe), [false, true, false, false]);
  assert.equal(r[2].nickname, '丙');
  assert.equal(r[2].avatarUrl, 'c');
  assert.equal(r[2].key, 'u9');
  assert.equal(r[3].nickname, '棋友');
  assert.equal(r[0].valueText, '8 连胜');
  assert.equal(r[0].subText, '');
  const w = rows.formatRows('winrate', [{ rank: 1, userId: 5, nickname: '甲', value: 0.75, games: 20, wins: 15 }], null);
  assert.equal(w[0].valueText, '75%');
  assert.equal(w[0].subText, '15 胜 / 20 局');
  assert.equal(w[0].isMe, false);
  assert.deepEqual(rows.formatRows('streak', 'x', 1), []);
  const noRank = rows.formatRows('streak', [{ userId: 1, value: 2 }, { userId: 2, value: 1 }], 1);
  assert.deepEqual(noRank.map((x) => x.rank), [1, 2], '缺少 rank 时按位置补');
});

test('formatMine：上榜 / 未上榜的说明', () => {
  assert.deepEqual(rows.formatMine('streak', { rank: 3, value: 4, games: 10, wins: 7 }, 10),
    { ranked: true, rankText: '第 3 名', valueText: '4 连胜', note: '' });
  const w = rows.formatMine('winrate', { rank: 12, value: 0.6, games: 20, wins: 12 }, 10);
  assert.equal(w.rankText, '第 12 名');
  assert.equal(w.valueText, '60%');
  assert.equal(w.note, '12 胜 / 20 局');
  const need = rows.formatMine('winrate', { rank: null, value: 0.5, games: 4, wins: 2, need: 6 }, 10);
  assert.equal(need.ranked, false);
  assert.equal(need.rankText, '未上榜');
  assert.equal(need.note, '再下 6 局排位即可上榜');
  assert.equal(need.valueText, '50%');
  const needCalc = rows.formatMine('winrate', { rank: null, games: 3, wins: 0 }, 10);
  assert.equal(needCalc.note, '再下 7 局排位即可上榜');
  assert.equal(needCalc.valueText, '0%');
  assert.equal(rows.formatMine('winrate', { rank: null, games: 0, wins: 0, need: 10 }, 10).valueText, '');
  assert.equal(rows.formatMine('streak', { rank: null, value: 0, games: 0 }, 10).note, '赢一局排位赛即可上榜');
  assert.match(rows.formatMine('streak', { rank: null, value: 0, games: 5 }, 10).note, /当前没有连胜/);
  assert.match(rows.formatMine('maxStreak', { rank: null, value: 0, games: 3 }, 10).note, /还没有排位赛胜局/);
  assert.equal(rows.formatMine('streak', null, 10).note, '暂无排位数据');
});

test('buildBoard：空榜、默认 minGames、提示文字', () => {
  const b = rows.buildBoard('winrate', { type: 'winrate', items: [], me: { rank: null, games: 2, wins: 1, need: 8 } }, 1);
  assert.equal(b.state, 'empty');
  assert.equal(b.minGames, 10);
  assert.match(b.hint, /至少 10 局/);
  assert.equal(b.mine.note, '再下 8 局排位即可上榜');
  const b2 = rows.buildBoard('streak', { items: [{ rank: 1, userId: 1, value: 2 }], me: { rank: 1, value: 2 }, minGames: 5 }, 1);
  assert.equal(b2.state, 'ok');
  assert.equal(b2.minGames, 5);
  assert.match(b2.hint, /只统计排位赛/);
  assert.equal(rows.buildBoard('streak', null, 1).state, 'empty');
  assert.equal(rows.isBoardType('maxStreak'), true);
  assert.equal(rows.isBoardType('elo'), false);
});

// ---------- 我的 ----------

test('formatDate：今天 / 昨天 / 今年 / 更早（本地时区）', () => {
  const now = new Date(2026, 8, 25, 10, 0).getTime();
  assert.equal(history.formatDate(new Date(2026, 8, 25, 9, 5).getTime(), now), '09:05');
  assert.equal(history.formatDate(new Date(2026, 8, 25, 0, 0).getTime(), now), '00:00');
  assert.equal(history.formatDate(new Date(2026, 8, 24, 23, 59).getTime(), now), '昨天 23:59');
  assert.equal(history.formatDate(new Date(2026, 8, 23, 23, 59).getTime(), now), '9月23日');
  assert.equal(history.formatDate(new Date(2025, 11, 31, 12, 0).getTime(), now), '2025年12月31日');
  assert.equal(history.formatDate(0, now), '');
  assert.equal(history.formatDate('bad', now), '');
});

test('describeResult：结果文本转中文', () => {
  assert.equal(history.describeResult('B+R'), '黑中盘胜');
  assert.equal(history.describeResult('W+T'), '白超时胜');
  assert.equal(history.describeResult('B+3.5'), '黑胜 3.5 目');
  assert.equal(history.describeResult('W+12'), '白胜 12 目');
  assert.equal(history.describeResult('0'), '和棋');
  assert.equal(history.describeResult('Void'), '对局作废');
  assert.equal(history.describeResult('W+'), '白胜');
  assert.equal(history.describeResult(''), '');
  assert.equal(history.describeResult(null), '');
  assert.equal(history.describeResult('???'), '???');
});

test('formatGameRow：真人与人机对局', () => {
  const now = new Date(2026, 8, 25, 10, 0).getTime();
  const ended = new Date(2026, 8, 25, 9, 30).getTime();
  const r = history.formatGameRow({
    id: 'g00000000001', mode: 'ranked', size: 19, myColor: 1,
    opponent: { id: 2, nickname: '对手', avatarUrl: 'http://x/o.png' },
    winner: 1, reason: 'score', resultText: 'B+3.5', myResult: 'win', moveCount: 212,
    createdAt: ended - 3600000, endedAt: ended,
  }, now);
  assert.equal(r.badge, '排位');
  assert.equal(r.badgeCls, 'ranked');
  assert.equal(r.opponentName, '对手');
  assert.equal(r.opponentAvatar, 'http://x/o.png');
  assert.equal(r.resultText, '胜');
  assert.equal(r.resultCls, 'win');
  assert.equal(r.meta, '19路 · 执黑 · 212手');
  assert.equal(r.detail, '黑胜 3.5 目');
  assert.equal(r.dateText, '09:30');
  assert.equal(r.isAi, false);

  const ai = history.formatGameRow({
    id: 'g00000000002', mode: 'ai', size: 9, myColor: 2,
    opponent: { ai: true, level: 'k5', levelName: '5级' }, myResult: 'loss', resultText: 'B+R', moveCount: 0,
    createdAt: ended,
  }, now);
  assert.equal(ai.badge, '人机');
  assert.equal(ai.opponentName, 'AI · 5级');
  assert.equal(ai.opponentAvatar, '');
  assert.equal(ai.isAi, true);
  assert.equal(ai.resultCls, 'loss');
  assert.equal(ai.meta, '9路 · 执白');
  assert.equal(ai.dateText, '09:30', '没有 endedAt 时用 createdAt');

  const v = history.formatGameRow({ id: 'g00000000003', mode: 'friend', myResult: 'void', opponent: null }, now);
  assert.equal(v.resultText, '作废');
  assert.equal(v.opponentName, '棋友');
  assert.equal(v.badge, '好友');
  assert.equal(history.formatGameRow({ id: 'g4', mode: 'friend', myResult: 'draw' }, now).resultText, '和');
  assert.equal(history.formatGameRow({ id: 'g5', myResult: '???' }, now).resultCls, 'void');
  assert.equal(history.formatGameRow({ id: 'g5', mode: 'weird' }, now).badgeCls, 'other');
  assert.equal(history.formatGameRow(null, now), null);
  assert.equal(history.formatGameRow({ id: '' }, now), null);
});

test('mergeGames：追加并按 id 去重', () => {
  const a = [{ id: '1' }, { id: '2' }];
  const merged = history.mergeGames(a, [{ id: '2' }, { id: '3' }, null, { id: '3' }]);
  assert.deepEqual(merged.map((x) => x.id), ['1', '2', '3']);
  assert.equal(a.length, 2, '不修改原数组');
  assert.deepEqual(history.mergeGames(null, [{ id: 'x' }]).map((x) => x.id), ['x']);
  assert.deepEqual(history.mergeGames([{ id: 'x' }], 'bad').map((x) => x.id), ['x']);
});

test('nextCursor / gamesPath', () => {
  assert.equal(history.nextCursor(1700000000000), 1700000000000);
  assert.equal(history.nextCursor('1700000000000'), 1700000000000);
  assert.equal(history.nextCursor(null), null);
  assert.equal(history.nextCursor(undefined), null);
  assert.equal(history.nextCursor(''), null);
  assert.equal(history.nextCursor('abc'), null);
  assert.equal(history.nextCursor(0), null);
  assert.equal(history.gamesPath(null, 20), '/api/games?limit=20');
  assert.equal(history.gamesPath(1700000000000, 20), '/api/games?limit=20&before=1700000000000');
  assert.equal(history.gamesPath(undefined), '/api/games?limit=20');
});

test('formatStats / formatAi / formatMe', () => {
  const s = history.formatStats({ games: 12, wins: 8, losses: 3, draws: 1, winrate: 0.6667, curStreak: 2, maxStreak: 5 });
  assert.deepEqual(s.cards.map((c) => c.value), ['12', '66.7%', '2', '5']);
  assert.deepEqual(s.cards.map((c) => c.label), ['局数', '胜率', '当前连胜', '最高连胜']);
  assert.equal(s.detail, '8 胜 3 负 1 和');
  const empty = history.formatStats(null);
  assert.deepEqual(empty.cards.map((c) => c.value), ['0', '—', '0', '0']);
  assert.match(empty.detail, /还没有排位赛记录/);
  assert.equal(history.formatStats({ games: 2, wins: 1, losses: 1 }).cards[1].value, '50%', '缺 winrate 时自己算');
  assert.equal(history.formatAi({ games: 5, wins: 2 }), '共 5 局 · 胜 2 局');
  assert.equal(history.formatAi(null), '还没有人机对局');
  const me = history.formatMe({
    user: { id: 1, nickname: '甲', avatarUrl: 'u' },
    needProfile: false,
    stats: { games: 0 },
    ai: { games: 1, wins: 1 },
    activeGameIds: ['abc000000001', '', 3],
  });
  assert.deepEqual(me.user, { id: 1, nickname: '甲', avatarUrl: 'u' });
  assert.equal(me.needProfile, false);
  assert.deepEqual(me.activeIds, ['abc000000001']);
  assert.equal(me.aiText, '共 1 局 · 胜 1 局');
  assert.equal(history.formatMe({ user: { id: 1, nickname: '' } }).needProfile, true);
  assert.deepEqual(history.formatMe(null).activeIds, []);
});

test('room-state.missedGameText：房主离线时好友加入的对局 → 说明原因；无关对局返回空', () => {
  const since = 1_000_000;
  const room = { size: 9, color: 'black' };
  const g = (over) => ({ id: 'g', mode: 'friend', size: 9, myColor: 1, reason: 'abort', myResult: 'void', moveCount: 0, createdAt: since + 5000, ...over });
  assert.equal(rs.missedGameText(g(), since, room), '好友加入后，你没有在 60 秒内落下第一手，对局已作废');
  assert.equal(rs.missedGameText(g({ myColor: 2 }), since, { size: 9, color: 'white' }), '好友加入后没有落下第一手，对局已作废');
  // 黑下了 1 手，轮到白（我）而我离线
  assert.equal(rs.missedGameText(g({ myColor: 2, moveCount: 1 }), since, { size: 9, color: 'random' }), '好友加入后你离线太久，对局已作废');
  assert.equal(rs.missedGameText(g({ myColor: 1, moveCount: 1 }), since, room), '好友离线太久，对局已作废');
  assert.equal(rs.missedGameText(g({ reason: 'timeout', myResult: 'loss', moveCount: 30 }), since, room), '好友加入后的对局已结束（你输了），可在"我的"查看棋谱');
  // 本机时钟比服务端快一点也能认出来
  assert.notEqual(rs.missedGameText(g({ createdAt: since - 30000 }), since, room), '');
  // 无关：太早、不是好友对局、路数或执子不同、没有数据
  assert.equal(rs.missedGameText(g({ createdAt: since - 120000 }), since, room), '');
  assert.equal(rs.missedGameText(g({ mode: 'ranked' }), since, room), '');
  assert.equal(rs.missedGameText(g({ size: 13 }), since, room), '');
  assert.equal(rs.missedGameText(g({ myColor: 2 }), since, room), '');
  assert.equal(rs.missedGameText(null, since, room), '');
  assert.equal(rs.missedGameText(g(), 0, room), '');
});

test('history.prependGames：新对局插到最前；没有新对局返回原列表副本；与现有列表无重叠返回 null', () => {
  const r = (id) => ({ id });
  assert.deepEqual(history.prependGames([r('b'), r('c')], [r('a'), r('b')]).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(history.prependGames([r('a')], [r('a')]).map((x) => x.id), ['a']);
  assert.equal(history.prependGames([r('x')], [r('a'), r('b')]), null);
  assert.deepEqual(history.prependGames([], [r('a')]).map((x) => x.id), ['a']);
  assert.deepEqual(history.prependGames([r('a')], null).map((x) => x.id), ['a']);
});
