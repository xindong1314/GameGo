'use strict';
const { HttpError, badRequest } = require('./errors');

// 请求体读取：JSON（默认上限 16KB）与 multipart/form-data（头像上传）。
// multipart 用 Node 内置 undici 的 Request.formData() 解析，不引入额外依赖。

const JSON_LIMIT = 16 * 1024;

function tooLarge(limit) {
  const kb = limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)}MB` : `${Math.round(limit / 1024)}KB`;
  return new HttpError(413, 'too_large', `请求内容过大（上限 ${kb}）`);
}

function mediaType(req) {
  const ct = req.headers['content-type'];
  if (typeof ct !== 'string') return '';
  return ct.split(';')[0].trim().toLowerCase();
}

// 读取完整请求体为 Buffer；超过 limit 时立即停止读取并抛 413（此时连接会在响应后关闭）
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const n = Number(declared);
      if (!Number.isFinite(n) || n < 0) {
        reject(badRequest('Content-Length 不正确'));
        return;
      }
      if (n > limit) {
        reject(tooLarge(limit));
        return;
      }
    }
    const chunks = [];
    let total = 0;
    let settled = false;

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function onData(chunk) {
      total += chunk.length;
      if (total > limit) {
        req.pause();
        fail(tooLarge(limit));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    }
    function onError(err) {
      fail(err);
    }
    function onClose() {
      // 'end' 之前连接就断了：客户端中止上传
      if (!req.complete) {
        const err = new Error('客户端在请求体传输完成前断开');
        err.code = 'ECONNRESET';
        fail(err);
      }
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// 读取 JSON 对象。未带 Content-Type 时也按 JSON 解析（兼容性），带了但不是 JSON 则 415。
async function readJson(req, limit = JSON_LIMIT) {
  const type = mediaType(req);
  if (type && type !== 'application/json' && !type.endsWith('+json')) {
    throw new HttpError(415, 'unsupported_media_type', '请求体必须是 JSON');
  }
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('请求体必须是 JSON 对象');
  return data;
}

// 读取 multipart 中名为 field 的文件 → { buffer, filename }
async function readMultipartFile(req, { field, maxFileBytes, maxBodyBytes }) {
  const ct = req.headers['content-type'];
  if (mediaType(req) !== 'multipart/form-data') {
    throw new HttpError(415, 'unsupported_media_type', '请使用 multipart/form-data 上传文件');
  }
  const body = await readBody(req, maxBodyBytes);
  let form;
  try {
    form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': ct }, body }).formData();
  } catch {
    throw badRequest('无法解析上传内容');
  }
  const file = form.get(field);
  if (!file || typeof file === 'string') throw badRequest(`缺少文件字段 ${field}`);
  if (file.size > maxFileBytes) throw tooLarge(maxFileBytes);
  const buffer = Buffer.from(await file.arrayBuffer());
  return { buffer, filename: typeof file.name === 'string' ? file.name : '' };
}

module.exports = { readBody, readJson, readMultipartFile, JSON_LIMIT, mediaType };
