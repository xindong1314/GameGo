'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { readMultipartFile } = require('./body');
const { detectImageType, inspectImage } = require('./validate');
const { HttpError, badRequest, notFound } = require('./errors');
const { AVATAR_FILE_RE } = require('../util/public-user');

// 头像：上传（multipart 字段 file，png/jpeg，≤2MB，宽高 ≤2048）与静态访问 /avatars/<file>

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MAX_SIDE = 2048; // 宽高上限：防止"文件很小、解码后极大"的图片拖垮看排行榜的手机
const MULTIPART_OVERHEAD = 64 * 1024; // 分隔符、字段头等的余量
const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg' };

// security：wx-security 的 { checkImage }（可选），内容安全检测
function createAvatarStore({ avatarDir, repos, logger, now, security = null }) {
  if (!avatarDir) throw new TypeError('createAvatarStore: 需要 avatarDir');

  async function removeFile(name) {
    if (!name || !AVATAR_FILE_RE.test(name)) return;
    try {
      await fs.promises.unlink(path.join(avatarDir, name));
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn('删除旧头像 %s 失败：%s', name, err.message);
    }
  }

  // 保存上传的头像并更新用户资料，返回更新后的 User。openid 用于内容安全检测
  async function upload(req, userId, { openid } = {}) {
    const { buffer } = await readMultipartFile(req, {
      field: 'file',
      maxFileBytes: AVATAR_MAX_BYTES,
      maxBodyBytes: AVATAR_MAX_BYTES + MULTIPART_OVERHEAD,
    });
    if (!detectImageType(buffer)) throw badRequest('头像只支持 PNG 或 JPEG 图片');
    let info = null;
    try {
      info = inspectImage(buffer);
    } catch {
      info = null; // 结构异常的图片（越界读等）一律按损坏处理，不能变成 500（LS-7）
    }
    if (!info) throw badRequest('图片文件不完整或已损坏，请换一张');
    if (info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE) {
      throw badRequest(`头像图片尺寸过大（最大 ${AVATAR_MAX_SIDE}×${AVATAR_MAX_SIDE}）`);
    }
    const ext = info.type;
    if (security) {
      const r = await security.checkImage(buffer, { openid, type: ext, width: info.width, height: info.height });
      if (!r.ok) {
        if (r.reason === 'risky') throw new HttpError(400, 'content_risky', '头像未通过内容安全检测，请更换');
        if (r.reason === 'too_large') throw badRequest('头像图片太大（最大 750×1334 像素、1MB），请换一张或裁小一点');
        throw new HttpError(503, 'sec_check_unavailable', '暂时无法检测头像内容，请稍后再试', { cause: r.error });
      }
    }

    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    await fs.promises.mkdir(avatarDir, { recursive: true });
    await fs.promises.writeFile(path.join(avatarDir, name), buffer, { flag: 'wx' });

    // 读旧头像与写新头像之间没有 await，同一用户并发上传也不会漏删
    let prev;
    let user;
    try {
      const current = repos.users.findById(userId);
      if (!current) throw notFound('用户不存在');
      prev = current.avatar;
      user = repos.users.updateProfile(userId, { avatar: name }, now());
    } catch (err) {
      await removeFile(name);
      throw err;
    }
    if (prev && prev !== name) await removeFile(prev);
    return user;
  }

  // GET/HEAD /avatars/<file>：文件名必须严格匹配 [a-z0-9]+\.(png|jpg)，杜绝路径穿越
  async function serve(req, res, file) {
    if (typeof file !== 'string' || !AVATAR_FILE_RE.test(file)) throw notFound('文件不存在');
    const full = path.join(avatarDir, file);
    let stat;
    try {
      stat = await fs.promises.stat(full);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw notFound('文件不存在');
      throw err;
    }
    if (!stat.isFile()) throw notFound('文件不存在');
    const ext = file.slice(file.lastIndexOf('.') + 1);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext],
      'Content-Length': stat.size,
      // 文件名随机且永不复用，可以长期缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Last-Modified': stat.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(fs.createReadStream(full), res);
  }

  return { upload, serve, removeFile };
}

module.exports = { createAvatarStore, AVATAR_MAX_BYTES, AVATAR_MAX_SIDE };
