// Hook fetch/XHR on qunar list page to capture the wbdflightlist request + response.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const port = 10300 + Math.floor(Math.random() * 80);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${UA}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--no-first-run', '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(200);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        target = (list || []).find((t) => t.type === 'page');
      } catch { /* retry */ }
    }
    if (!target) throw new Error('CDP not ready');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    let send = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    send = (method, params = {}) => new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable', {});
    await send('Network.setUserAgentOverride', { userAgent: UA });

    // inject hooks before navigation
    await evalJs(`
      window.__captured = [];
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const rec = { url, method: (init && init.method) || 'GET', postData: (init && init.body) || '', resp: null };
        window.__captured.push(rec);
        return origFetch.apply(this, arguments).then(async (r) => {
          try { rec.resp = (await r.clone().text()).slice(0, 200000); } catch {}
          return r;
        });
      };
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__rec = { url: u, method: m, postData: '', resp: null }; window.__captured.push(this.__rec); return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function (b) { if (this.__rec) this.__rec.postData = b || ''; this.addEventListener('load', () => { if (this.__rec) this.__rec.resp = (this.responseText || '').slice(0, 200000); }); return origSend.apply(this, arguments); };
      'hooks installed';
    `);

    await send('Page.navigate', { url: 'https://flight.qunar.com/site/oneway_list.htm?searchDepartureAirport=%E5%B9%BF%E5%B7%9E&searchArrivalAirport=%E5%8C%97%E4%BA%AC&searchDepartureTime=2026-08-20&adultCount=1&childCount=0&infantCount=0&cabin=y_s&qihangTime=&daodatime=&qunar_brand_think=&from=qunarindex&searchType=1&lowprice=undefined&qfrom=qunarindex' });
    await sleep(15000);

    const captured = await evalJs(`JSON.stringify(window.__captured.filter((c) => /wbdflightlist|flightlist|price|lowprice/i.test(c.url)))`);
    const arr = JSON.parse(captured || '[]');
    console.log('captured api calls:', arr.length);
    arr.forEach((c, i) => {
      console.log('---', i, c.method, c.url);
      console.log('REQ:', String(c.postData).slice(0, 400));
      console.log('RESP:', String(c.resp).slice(0, 500));
    });
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
