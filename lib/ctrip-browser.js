'use strict';

// 携程国内航线实时数据：使用本机真实浏览器（可见窗口）绕过 whaleguard，
// 逐路线导航到携程列表页并抓取渲染后的航班卡。结果按 路线+日期 缓存。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { continuationsFor, getCity } = require('./cities');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async connect() {
    if (this.ready && this.ws) return;
    console.error('[ctrip-browser] 启动浏览器会话…');
    const browser = findBrowser();
    if (!browser) throw new Error('未找到 Edge/Chrome（携程备用源需要浏览器；可通过 EDGE_PATH 环境变量指定路径）');
    this.proc = spawn(browser, [
      '--disable-blink-features=AutomationControlled',
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userData}`,
      '--no-first-run', '--disable-extensions',
      '--start-maximized',
      'https://flights.ctrip.com/',
    ], { stdio: 'ignore', windowsHide: false });

    let target = null;
    for (let i = 0; i < 120 && !target; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
        const list = await res.json();
        target = (list || []).find((t) => t.type === 'page');
      } catch { /* retry */ }
    }
    if (!target) throw new Error('无法连接携程浏览器会话（Edge 未启动或被拦截）');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
    this.ws = ws;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    this.ready = true;
    console.error('[ctrip-browser] 会话已连接');
    // 等首页稳定（建立会话）
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const state = await this.evalJs(`document.readyState`);
        if (state === 'complete') break;
      } catch { /* retry */ }
    }
    await sleep(3000);
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面脚本错误: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async navigate(url, waitFor = '订票', timeoutMs = 75000) {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1200);
      let st = 'loading';
      try {
        st = await this.evalJs(`(function () {
          const t = document.body ? document.body.innerText : '';
          if (/未找到符合条件的航班|无法查询到对应价格|暂时无法查询/.test(t)) return 'empty';
          if (/订票/.test(t)) return 'ok';
          return 'loading';
        })()`);
      } catch { /* 页面导航中，跳过本轮 */ }
      if (st === 'ok') return;
      if (st === 'empty') throw new Error('EMPTY_RESULT');
    }
    try {
      const pageText = await this.evalJs(`(document.body ? document.body.innerText : '').slice(0, 300)`);
      console.error('[ctrip-browser] 页面超时，当前文本:', pageText);
    } catch {}
    throw new Error('页面加载超时（可能被风控或网络问题拦截）');
  }

  async scrapeCards() {
    const raw = await this.evalJs(`
      JSON.stringify(Array.from(document.querySelectorAll('div.flight-item')).map((el) => el.innerText))`);
    const texts = JSON.parse(raw || '[]');
    const cards = [];
    for (const t of texts) {
      const card = parseCard(t);
      if (card && card.price) cards.push(card);
    }
    return cards;
  }

  async searchRoute(fromCode, toCode, date) {
    const key = `${fromCode}-${toCode}-${date}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheTtlMs) return hit.cards;
    console.error(`[ctrip-browser] 查询 ${fromCode}->${toCode} ${date}`);
    await this.navigate(`https://flights.ctrip.com/online/list/oneway-${fromCode}-${toCode}?depdate=${date}`);
    await sleep(2500); // 等列表完全渲染
    const cards = await this.scrapeCards();
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

async function searchCtripDomestic(query) {
  const { from, to, date } = query;
  const run = async () => {
    if (!singleton) singleton = new CtripBrowser();
    const br = singleton;
    await br.connect();

    // 1) 直飞价：O→D 页面上不含中转/经停的最低卡
    const directCards = await br.searchRoute(from.code, to.code, date);
    const directOnly = directCards.filter((c) => !c.transfer && !c.stopover);
    if (!directOnly.length) return null;
    const bestDirect = directOnly.reduce((a, b) => (a.price <= b.price ? a : b));

    // 2) 甩尾方案：对 D 的续程城市 C，查 O→C 页面，找“经 D 中转/经停”的卡
    const deals = [];
    const seen = new Set();
    const limit = Number(process.env.CTRIP_TAILS_LIMIT) || 3;
    const tailCodes = continuationsFor(to.code);
    const usedCities = new Set();
    let checked = 0;
    for (const tc of tailCodes) {
      const tail = getCity(tc);
      if (!tail) continue;
      if (usedCities.has(tail.city) || tail.city === from.city || tail.city === to.city) continue;
      usedCities.add(tail.city);
      if (checked >= limit) break;
      checked++;
      try {
        const cards = await br.searchRoute(from.code, tail.code, date);
        for (const c of cards) {
          if ((!c.transfer && !c.stopover) || !c.stopCity) continue;
          if (c.stopCity !== to.city) continue; // 只有经停/中转在目的地的才是甩尾方案
          const key = `${c.airline}|${c.depTime}|${c.arrTime}|${c.price}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deals.push({
            tailCode: tail.code,
            tailCity: tail.city,
            card: c,
          });
        }
      } catch { /* 单条路线失败不影响整体 */ }
    }

    deals.sort((a, b) => a.card.price - b.card.price);
    return { bestDirect, directCards, deals };
  };

  try {
    return await run();
  } catch (e) {
    // 会话被风控/超时：换全新浏览器会话重试一次
    if (singleton) { try { singleton.close(); } catch {} }
    singleton = null;
    try {
      return await run();
    } catch (e2) {
      throw e2;
    }
  }
}

module.exports = { searchCtripDomestic, CtripBrowser, parseCard, cacheKey };
