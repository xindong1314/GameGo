'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openDb, createRepos } = require('../../src/db');
const { defaultConfig } = require('../../src/config');
const { createHttpServer } = require('../../src/http/server');
const { silentLogger } = require('../../src/logger');

const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 25, 0, 0, 0);

function makeRepos(options = {}) {
  const db = openDb(':memory:');
  const repos = createRepos(db, options);
  return { db, repos };
}

function tmpDir(prefix = 'gamego-core-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 可手动推进的时钟
function makeClock(start = T0) {
  let t = start;
  const now = () => t;
  now.set = (v) => {
    t = v;
  };
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

let gameSeq = 0;
function gameId() {
  gameSeq += 1;
  return `g${String(gameSeq).padStart(11, '0')}`;
}

// 插入一局排位赛并返回 id
function insertRanked(repos, blackId, whiteId, createdAt = T0, extra = {}) {
  const id = extra.id || gameId();
  repos.games.insert({
    id,
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    blackId,
    whiteId,
    timeControl: { mainMs: 180000, periods: 3, periodMs: 20000 },
    status: 'playing',
    moves: [],
    createdAt,
    ...extra,
  });
  return id;
}

// 启动只含 REST 的服务（端口 0、内存数据库、临时头像目录）
async function startHttp({
  config: overrides = {},
  ai = { available: () => true, levels: () => [{ id: 'k5', name: '5级', desc: '' }] },
  getActiveGames = () => [],
  now = makeClock(),
  fetch,
  limits,
  logger = silentLogger,
} = {}) {
  const dataDir = tmpDir();
  const config = defaultConfig({ dataDir, publicBaseUrl: 'https://go.example.com', ...overrides });
  const db = openDb(':memory:');
  const repos = createRepos(db, { publicBaseUrl: config.publicBaseUrl, minGamesWinrate: config.minGamesWinrate });
  const server = createHttpServer({ config, repos, ai, logger, now, getActiveGames, fetch, limits });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function api(method, p, { token, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      if (!h['content-type']) h['content-type'] = 'application/json';
    }
    const res = await fetch_(base + p, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  async function devLogin(deviceId) {
    const r = await api('POST', '/api/auth/dev-login', { body: { deviceId } });
    if (r.status !== 200) throw new Error(`dev-login 失败 ${r.status} ${r.text}`);
    return r.json;
  }

  async function close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmDir(dataDir);
  }

  return { base, port, server, repos, db, config, now, api, devLogin, close, dataDir };
}

const fetch_ = (...args) => globalThis.fetch(...args);

// 原样发送请求路径（fetch 会规范化 ".."，测路径穿越要用 http.request）
function rawRequest(port, method, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 一张真实的 1×1 PNG（IHDR / IDAT / IEND）
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0b5fd6a0000000049454e44ae426082',
  'hex',
);

// 结构完整的最小 JPEG：SOI、APP0(JFIF)、SOF0（宽高）、SOS、少量数据、EOI（服务端只检查结构，不解码）
function jpegOf(width = 1, height = 1) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    sof,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
const JPEG_BYTES = jpegOf(1, 1);

// 宽高为 width×height、总长正好 total 字节的 PNG（用私有辅助块 zPAD 填充；服务端不校验 CRC）
function pngOf({ width = 1, height = 1, total } = {}) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const head = Buffer.concat([PNG_BYTES.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from('78da63f8cfc0f01f0005000201', 'hex'))]);
  const iend = PNG_BYTES.subarray(PNG_BYTES.length - 12);
  const pad = total === undefined ? Buffer.alloc(0) : chunk('zPAD', Buffer.alloc(total - head.length - iend.length - 12));
  return Buffer.concat([head, pad, iend]);
}

module.exports = {
  DAY,
  T0,
  makeRepos,
  tmpDir,
  rmDir,
  makeClock,
  gameId,
  insertRanked,
  startHttp,
  rawRequest,
  PNG_BYTES,
  JPEG_BYTES,
  jpegOf,
  pngOf,
};
