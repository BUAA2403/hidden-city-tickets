'use strict';

// 通过本机浏览器读取携程公开列表页的航班卡。结果按路线和日期缓存。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setTimeout: sleep } = require('node:timers/promises');
const { continuationsFor, getCity, hasOtherAirport } = require('./cities');

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    process.env.BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let singleton = null;
let searchQueue = Promise.resolve();

class CtripBrowser {
  constructor() {
    this.port = 11000 + Math.floor(Math.random() * 400);
    this.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrip-live-'));
    this.proc = null;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.cache = new Map();
    this.ready = false;
    this.cacheTtlMs = Number(process.env.CTRIP_CACHE_TTL_MS) || 2 * 3600 * 1000;
  }

  async connect(signal) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) return;
    console.error('[ctrip-browser] 启动浏览器会话…');
    const browser = findBrowser();
    if (!browser) throw new Error('未找到 Edge/Chrome（携程备用源需要浏览器；可通过 EDGE_PATH 环境变量指定路径）');
    this.proc = spawn(browser, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userData}`,
      '--no-first-run', '--disable-extensions',
      '--start-maximized',
      'https://flights.ctrip.com/',
    ], { stdio: 'ignore', windowsHide: false });
    let launchError;
    this.proc.once('error', (error) => { launchError = error; });

    let target = null;
    for (let i = 0; i < 120 && !target; i++) {
      await sleep(250, undefined, { signal });
      if (launchError) throw launchError;
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const list = await res.json();
        target = (list || []).find((t) => t.type === 'page');
      } catch { /* retry */ }
    }
    if (!target) throw new Error('无法连接携程浏览器会话（Edge 未启动或被拦截）');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接携程浏览器会话超时')), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('无法连接携程浏览器会话')); };
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg.error ? new Error(msg.error.message) : null, msg);
      }
    };
    ws.onclose = () => {
      this.ready = false;
      for (const finish of this.pending.values()) finish(new Error('携程浏览器会话已断开'));
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    this.ready = true;
    console.error('[ctrip-browser] 会话已连接');
    // 等首页稳定（建立会话）
    for (let i = 0; i < 8; i++) {
      await sleep(500, undefined, { signal });
      try {
        const state = await this.evalJs(`document.readyState`);
        if (state === 'complete') break;
      } catch { /* retry */ }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error('携程浏览器会话未连接'));
        return;
      }
      const id = ++this.msgId;
      const finish = (error, message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(message);
      };
      const timer = setTimeout(() => finish(new Error(`浏览器命令超时：${method}`)), 5000);
      this.pending.set(id, finish);
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        finish(error);
      }
    });
  }

  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面脚本错误: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async navigate(url, signal) {
    const expected = new URL(url);
    const navigation = await this.send('Page.navigate', { url });
    if (navigation.result?.errorText) throw new Error(navigation.result.errorText);
    const deadline = Date.now() + 12000;
    let emptyChecks = 0;
    while (Date.now() < deadline) {
      await sleep(500, undefined, { signal });
      try {
        const page = await this.evalJs(`(() => {
          if (location.origin !== ${JSON.stringify(expected.origin)} ||
              location.pathname.toLowerCase() !== ${JSON.stringify(expected.pathname.toLowerCase())} ||
              new URLSearchParams(location.search).get('depdate') !== ${JSON.stringify(expected.searchParams.get('depdate'))}) return null;
          const empty = document.readyState === 'complete' &&
            /未找到符合条件的航班|无法查询到对应价格|暂时无法查询/.test(document.body?.innerText || '');
          const texts = Array.from(document.querySelectorAll('div.flight-item'), (card) => card.innerText);
          return { empty, texts };
        })()`);
        if (!page) continue;
        const cards = page.texts.map(parseCard).filter((card) => card?.price > 0);
        if (cards.length) return cards;
        // 页面加载期间可能短暂显示空状态。
        emptyChecks = page.empty ? emptyChecks + 1 : 0;
      } catch { /* 页面导航中，跳过本轮 */ }
      if (emptyChecks >= 3) throw new Error('携程页面未找到符合条件的航班');
    }
    throw new Error('携程航班列表加载超时');
  }

  async searchRoute(fromCode, toCode, date, signal) {
    const key = `${fromCode}-${toCode}-${date}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheTtlMs) return hit.cards;
    console.error(`[ctrip-browser] 查询 ${fromCode}->${toCode} ${date}`);
    const cards = await this.navigate(`https://flights.ctrip.com/online/list/oneway-${fromCode}-${toCode}?depdate=${date}`, signal);
    console.error(`[ctrip-browser] ${fromCode}->${toCode} 卡片 ${cards.length} 张`);
    this.cache.set(key, { ts: Date.now(), cards });
    return cards;
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch {}
    try { if (this.proc) this.proc.kill(); } catch {}
    this.ready = false;
    singleton = null;
  }
}

function parseCard(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const priceMatch = text.match(/¥\s*(\d+)\s*起/);
  const times = text.match(/\b(\d{1,2}):(\d{2})\b/g) || [];
  if (!priceMatch || times.length < 2) return null;

  // 航司：第一个时间之前的所有文本行
  let airline = '航班';
  for (const line of lines) {
    if (/\d{1,2}:\d{2}/.test(line)) break;
    if (line && !/¥/.test(line) && line.length < 30) { airline = line; }
  }
  const flightNo = (text.match(/\b[A-Z]{2}\s?\d{3,4}\b/) || [''])[0].replace(/\s/g, '');
  const transfer = /中转/.test(text);
  const stopover = /经停/.test(text);
  // 中转城市：转上海21h15m / 中转城市名
  let stopCity = '';
  const m1 = text.match(/转([\u4e00-\u9fa5]{2,5}?)\s?\d+h\d+m/);
  const m2 = text.match(/经停\s*([\u4e00-\u9fa5]{2,5})/);
  const m3 = text.match(/中转\s*([\u4e00-\u9fa5]{2,5})/);
  if (m1) stopCity = m1[1];
  else if (m2) stopCity = m2[1];
  else if (m3) stopCity = m3[1];

  return {
    text,
    airline,
    flightNo,
    depTime: times[0],
    arrTime: times[times.length - 1],
    arrNextDay: /\+1\s*天/.test(text),
    price: Number(priceMatch[1]),
    layoverMin: transferMin(text),
    transfer,
    stopover,
    stopCity,
  };
}

function transferMin(text) {
  const m = (text || '').match(/(\d+)h\s*(\d+)m/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function cacheKey(city) {
  return city;
}

async function runCtripSearch(query, signal) {
  const { from, to, date } = query;
  const run = async () => {
    signal?.throwIfAborted();
    if (!singleton) singleton = new CtripBrowser();
    const br = singleton;
    await br.connect(signal);

    // 1) 直飞价：O→D 页面上不含中转/经停的最低卡
    const directCards = await br.searchRoute(from.code, to.code, date, signal);
    const directOnly = directCards.filter((c) => !c.transfer && !c.stopover);
    if (!directOnly.length) return null;
    const bestDirect = directOnly.reduce((a, b) => (a.price <= b.price ? a : b));

    // 2) 甩尾方案：对 D 的续程城市 C，查 O→C 页面，找“经 D 换机”的卡
    const deals = [];
    const seen = new Set();
    const limit = Number(process.env.CTRIP_TAILS_LIMIT) || 3;
    const tailCodes = continuationsFor(to.code);
    const usedCities = new Set();
    const needsAirport = hasOtherAirport(to);
    let checked = 0;
    let partialSearch = false;
    for (const tc of tailCodes) {
      if (signal?.aborted) {
        partialSearch = true;
        break;
      }
      const tail = getCity(tc);
      if (!tail) continue;
      if (usedCities.has(tail.city) || tail.city === from.city || tail.city === to.city) continue;
      usedCities.add(tail.city);
      if (checked >= limit) break;
      checked++;
      try {
        const cards = await br.searchRoute(from.code, tail.code, date, signal);
        for (const c of cards) {
          if (!c.transfer || c.stopover || !c.stopCity) continue;
          if (c.stopCity !== to.city) continue;
          if (needsAirport && !c.text.includes(to.airport)) {
            partialSearch = true;
            continue;
          }
          const key = `${tail.code}|${c.airline}|${c.depTime}|${c.arrTime}|${c.price}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deals.push({
            tailCode: tail.code,
            tailCity: tail.city,
            card: c,
          });
        }
      } catch {
        partialSearch = true;
      }
    }

    deals.sort((a, b) => a.card.price - b.card.price);
    return { bestDirect, directCards, deals, partialSearch };
  };

  try {
    return await run();
  } catch {
    // 保留已连通的会话，避免重试时重新初始化浏览器与页面。
    if (singleton && !singleton.ready) singleton.close();
    try {
      return await run();
    } catch (error) {
      singleton?.close();
      throw error;
    }
  }
}

async function searchCtripDomestic(query, signal) {
  if (typeof WebSocket !== 'function') {
    throw new Error('携程备用源需要 Node.js 22 或更高版本');
  }
  // 单个浏览器标签页逐条查价，避免并发请求相互覆盖导航。
  const result = searchQueue.then(() => runCtripSearch(query, signal));
  searchQueue = result.catch(() => {});
  return result;
}

module.exports = { searchCtripDomestic, CtripBrowser, parseCard, cacheKey };
