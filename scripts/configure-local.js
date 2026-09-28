'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isPrivateIpv4(address) {
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = /^172\.(\d+)\./.exec(address);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

function isIpv4(address) {
  const parts = String(address || '').split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function detectHost() {
  const virtualName = /vmware|virtual|vbox|hyper-v|vethernet|tailscale|loopback/i;
  const candidates = [];

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses || []) {
      const family = item.family === 4 ? 'IPv4' : item.family;
      if (family !== 'IPv4' || item.internal || !isPrivateIpv4(item.address)) continue;
      candidates.push({ name, address: item.address, virtual: virtualName.test(name) });
    }
  }

  const selected = candidates.find((item) => !item.virtual) || candidates[0];
  if (!selected) {
    throw new Error('没有检测到可用的局域网 IPv4 地址，请执行：npm run config:local -- 你的IP 8080');
  }
  return selected.address;
}

const host = process.argv[2] || detectHost();
const port = Number(process.argv[3] || 8080);

if (!isIpv4(host)) throw new Error(`无效的 IPv4 地址：${host}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效的端口：${process.argv[3]}`);

const target = path.join(__dirname, '..', 'miniprogram', 'config.local.js');
const content = `'use strict';

// 本文件由 npm run config:local 生成，仅供当前电脑联调，不提交 Git。
module.exports = {
  API_BASE: 'http://${host}:${port}',
  WS_URL: 'ws://${host}:${port}/ws',
  DEV_LOGIN: true,
};
`;

fs.writeFileSync(target, content, 'utf8');
console.log(`已生成 ${path.relative(process.cwd(), target)}`);
console.log(`API_BASE=http://${host}:${port}`);
console.log(`WS_URL=ws://${host}:${port}/ws`);
