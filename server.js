'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');
const { CITIES } = require('./lib/cities');

// 简单 .env 加载器（无第三方依赖）：项目根目录放 .env 即可覆盖默认配置
function loadDotEnv() {
  try {
    const envFile = path.join(__dirname, '.env');
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const line of lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (key in process.env) continue; // 已存在的环境变量优先，不覆盖
      process.env[key] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env 缺失或损坏时忽略 */ }
}
loadDotEnv();
const { search } = require('./lib/engine');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_ID = 'hidden-city-tickets';
const appUrl = `http://localhost:${PORT}`;
const openOnStart = process.platform === 'win32' && process.argv.includes('--open');

function openBrowser() {
  execFile('explorer.exe', [appUrl], { windowsHide: true }, () => {});
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      if (size > limit) return;
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && p === '/api/cities') {
      const slim = CITIES.map((c) => ({ code: c.code, city: c.city, en: c.en, airport: c.airport }));
      return sendJson(res, 200, { cities: slim });
    }

    if (req.method === 'GET' && p === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        app: APP_ID,
        version: 1,
        node: process.version,
        providers: {
          tripcom: '实时 · 国际航线（FlightSelectSearch 直连）',
          lycom: '实时 · 国内航线（同程接口直连）',
          ctrip: process.env.CTRIP_BROWSER_ENABLED === '1' ? '备用 · 国内航线（本机浏览器）' : '浏览器备用源未启用',
          skyscanner: '仅提供跳转链接',
        },
        config: {
          port: PORT,
          lycomTailsLimit: Number(process.env.LYCOM_TAILS_LIMIT) || 32,
          lycomCacheTtlMs: Number(process.env.LYCOM_CACHE_TTL_MS) || 1800000,
          tripcomTailsLimit: Number(process.env.TRIPCOM_TAILS_LIMIT) || 18,
          tripcomCacheTtlMs: Number(process.env.TRIPCOM_CACHE_TTL_MS) || 1800000,
          mixedTailsLimit: Number(process.env.MIXED_TAILS_LIMIT) || 10,
          ctripTailsLimit: Number(process.env.CTRIP_TAILS_LIMIT) || 3,
        },
        defaultMode: 'live',
        now: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && p === '/api/search') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        if (error.code === 'BODY_TOO_LARGE') {
          return sendJson(res, 413, { error: '请求体过大。' });
        }
        return sendJson(res, 400, { error: '请求体不是有效的 JSON。' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: '请求体必须是 JSON 对象。' });
      }
      const result = await search({
        from: String(body.from || '').toUpperCase(),
        to: String(body.to || '').toUpperCase(),
        date: String(body.date || ''),
        mode: String(body.mode || 'auto'),
        cabin: String(body.cabin || 'economy'),
      });
      const { statusCode, ...payload } = result;
      return sendJson(res, statusCode || (payload.error ? 400 : 200), payload);
    }

    if (req.method === 'GET' && p.startsWith('/api/')) {
      return sendJson(res, 404, { error: '接口不存在。' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(res, p);
    }

    res.writeHead(405); res.end('Method Not Allowed');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: '服务器内部错误。' });
  }
});

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    if (openOnStart) {
      try {
        const response = await fetch(`${appUrl}/api/status`, { signal: AbortSignal.timeout(2000) });
        if (response.ok && (await response.json()).app === APP_ID) {
          console.log(`甩尾票搜索已在运行：${appUrl}`);
          openBrowser();
          return;
        }
      } catch { /* 端口上的进程未返回本应用的状态 */ }
    }
    console.error(`\n端口 ${PORT} 已被占用。请在 .env 中更改 PORT，或关闭占用端口的进程后重试。\n`);
    process.exitCode = 1;
    return;
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`甩尾票搜索已启动：${appUrl}`);
  console.log(`API 状态：${appUrl}/api/status`);
  if (openOnStart) openBrowser();
});
