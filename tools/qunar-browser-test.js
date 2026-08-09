// Test qunar wbdflightlist from inside a live browser session (with page-set cookies/tokens).
// Usage: node tools/qunar-browser-test.js
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const port = 10200 + Math.floor(Math.random() * 80);
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
    await send('Page.navigate', { url: 'https://flight.qunar.com/site/oneway_list.htm?searchDepartureAirport=%E5%B9%BF%E5%B7%9E&searchArrivalAirport=%E5%8C%97%E4%BA%AC&searchDepartureTime=2026-08-20&adultCount=1&childCount=0&infantCount=0&cabin=y_s&qihangTime=&daodatime=&qunar_brand_think=&from=qunarindex&searchType=1&lowprice=undefined&qfrom=qunarindex' });
    await sleep(10000);

    const body = 'departureCity=%E5%B9%BF%E5%B7%9E&arrivalCity=%E5%8C%97%E4%BA%AC&departureDate=2026-08-20&ex_track=&sort=';
    for (let i = 0; i < 4; i++) {
      const out = await evalJs(`
        (async () => {
          try {
            const res = await fetch('/touch/api/domestic/wbdflightlist', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
              body: ${JSON.stringify(body)},
            });
            const txt = await res.text();
            let brief = 'len=' + txt.length;
            try {
              const j = JSON.parse(txt);
              brief = JSON.stringify({ code: j.code, ret: j.ret, total: j.data && j.data.total, flights: j.data && j.data.flights ? j.data.flights.length : 0 });
            } catch {}
            return brief;
          } catch (e) { return 'ERR ' + e.message; }
        })()`);
      console.log('browser call', i + 1, ':', out);
      await sleep(1500);
    }
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
