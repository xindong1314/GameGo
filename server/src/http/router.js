'use strict';

// 极简路由：'/api/games/:id' 形式的路径模板，参数取原始（未解码）的路径段。
// HEAD 请求按 GET 路由匹配（Node 会自动丢弃 HEAD 响应的正文）。

function compile(pattern) {
  const names = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${src}$`), names };
}

function createRouter() {
  const routes = [];

  function add(method, pattern, handler, options = {}) {
    const { re, names } = compile(pattern);
    routes.push({ method: method.toUpperCase(), pattern, re, names, handler, options });
  }

  // → { route, params } | { allowed: string[] }（路径存在但方法不对）| null
  function match(method, pathname) {
    const m = method === 'HEAD' ? 'GET' : method;
    const allowed = new Set();
    for (const route of routes) {
      const hit = route.re.exec(pathname);
      if (!hit) continue;
      if (route.method !== m) {
        allowed.add(route.method);
        if (route.method === 'GET') allowed.add('HEAD');
        continue;
      }
      const params = {};
      route.names.forEach((name, i) => {
        params[name] = hit[i + 1];
      });
      return { route, params };
    }
    return allowed.size ? { allowed: [...allowed] } : null;
  }

  return { add, match, routes };
}

module.exports = { createRouter };
