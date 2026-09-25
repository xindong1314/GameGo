'use strict';

// REST 统一错误：HTTP 状态码 + { error: { code, msg } }

class HttpError extends Error {
  constructor(status, code, msg, { headers, cause } = {}) {
    super(msg || code, cause ? { cause } : undefined);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.msg = msg || '';
    this.headers = headers || null;
  }
}

const badRequest = (msg) => new HttpError(400, 'bad_request', msg || '请求参数不正确');
const unauthorized = (msg) => new HttpError(401, 'unauthorized', msg || '请先登录');
const notFound = (msg) => new HttpError(404, 'not_found', msg || '资源不存在');

module.exports = { HttpError, badRequest, unauthorized, notFound };
