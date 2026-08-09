// Drive Trip.com search UI with trusted CDP input events; capture resulting navigation + API.
// Usage: node tools/trip-ui.js [--from=CAN] [--to=PEK]
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const args = process.argv.slice(2);
const from = (args.find((a) => a.startsWith('--from=')) || '--from=CAN').split('=')[1];
const to = (args.find((a) => a.startsWith('--to=')) || '--to=PEK').split('=')[1];
const CITY_NAME = { CAN: 'Guangzhou', PEK: 'Beijing', SHA: 'Shanghai', CTU: 'Chengdu', SZX: 'Shenzhen', HKG: 'Hong Kong', SIN: 'Singapore', NRT: 'Tokyo', KIX: 'Osaka', ICN: 'Seoul', BKK: 'Bangkok', XIY: 'Xi an', KMG: 'Kunming', CKG: 'Chongqing', PVG: 'Shanghai' };
const fromName = CITY_NAME[from] || from;
const toName = CITY_NAME[to] || to;
const port = 10000 + Math.floor(Math.random() * 80);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const outBase = path.join(os.tmpdir(), `tripui_${from}_${to}_${Date.now()}`);

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
    const apiCalls = [];
    let send = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const r = msg.params.request;
        if (/soa2|19866|flight|search/i.test(r.url)) {
          apiCalls.push({ method: r.method, url: r.url, postData: r.postData || '' });
        }
      }
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        if (/19866|flight|search/i.test(r.url) && /json/i.test(r.mimeType) && r.status === 200) {
          send('Network.getResponseBody', { requestId: msg.params.requestId }).then((res) => {
            if (res && res.result) apiCalls.push({ method: 'RESP', url: r.url, body: res.result.body });
          }).catch(() => {});
        }
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
    await send('Page.navigate', { url: 'https://www.trip.com/flights/' });
    await sleep(9000);

    const findInput = (which) => `
      (function () {
        const sel = ${JSON.stringify(which === 'to' ? '[data-aria-id*="search_city_to"]' : '[data-aria-id*="search_city_from"]')};
        const el = document.querySelector(sel) || Array.from(document.querySelectorAll('input')).find((e) => ${JSON.stringify(which === 'to' ? 'arriv' : 'depart')}.test((e.placeholder || '') + ' ' + (e.getAttribute('aria-label') || '')));
        if (!el) return 'no input';
        el.scrollIntoView({ block: 'center' });
        el.focus();
        return 'focused ' + (el.getAttribute('aria-label') || el.placeholder) + ' id=' + (el.id || '') + ' aria=' + (el.getAttribute('data-aria-id') || '');
      })()`;

    console.log('FOCUS FROM:', await evalJs(findInput('from')));
    await sleep(500);
    await send('Input.insertText', { text: fromName });
    await sleep(3500);

    const dump = await evalJs(`
      JSON.stringify(Array.from(document.querySelectorAll('li,div,span')).filter((e) => {
        const t = (e.textContent || '').trim();
        return t.length < 70 && (e.className || '').toString().match(/item|option|suggest|dropdown|city|airport|poi/i);
      }).map((e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 70), text: e.textContent.trim().slice(0, 55), vis: !!(e.offsetParent || e.getClientRects().length) })).filter((x) => x.vis).slice(0, 40))`);
    console.log('VISIBLE SUGGESTIONS:', dump);

    const clickCity = (code, cityEn) => `
      (function () {
        const all = Array.from(document.querySelectorAll('li,div,span'));
        const vis = all.filter((e) => e.offsetParent || e.getClientRects().length);
        const el = vis.find((e) => {
          const t = (e.textContent || '').trim();
          return t.length < 55 && t.indexOf('(' + ${JSON.stringify(code)} + ')') !== -1 && e.children.length <= 2;
        });
        if (el) { el.click(); return 'clicked: ' + el.textContent.trim().slice(0, 45) + ' | ' + el.className; }
        const fb = vis.find((e) => {
          const t = (e.textContent || '').trim();
          return t.length < 55 && new RegExp(${JSON.stringify(cityEn)}).test(t) && e.children.length <= 1;
        });
        if (fb) { fb.click(); return 'fallback: ' + fb.textContent.trim().slice(0, 45) + ' | ' + fb.className; }
        return 'none';
      })()`;

    console.log('PICK FROM:', await evalJs(clickCity(from, fromName)));
    await sleep(2000);
    console.log('FOCUS TO:', await evalJs(findInput('to')));
    await sleep(500);
    await send('Input.insertText', { text: toName });
    await sleep(3500);
    console.log('PICK TO:', await evalJs(clickCity(to, toName)));
    await sleep(2000);

    const oneway = await evalJs(`
      (function () {
        const all = Array.from(document.querySelectorAll('div,button,span,a')).filter((e) => e.offsetParent || e.getClientRects().length);
        const el = all.find((e) => {
          const t = (e.textContent || '').trim();
          return /^One-way$/i.test(t) && e.children.length <= 2;
        });
        if (el) { (el.closest('button') || el).click(); return 'clicked oneway'; }
        return 'no oneway';
      })()`);
    console.log('ONEWAY:', oneway);
    await sleep(1000);

    const search = await evalJs(`
      (function () {
        const btns = Array.from(document.querySelectorAll('[data-testid="search_btn"],button,div')).filter((e) => e.offsetParent || e.getClientRects().length);
        const el = btns.find((e) => {
          const t = (e.textContent || '').trim();
          return (/^Search$/i.test(t) && t.length <= 12) || (e.getAttribute && e.getAttribute('data-testid') === 'search_btn');
        });
        if (el) { (el.closest('button') || el).click(); return 'search clicked: ' + el.tagName + ' ' + (el.getAttribute('data-testid') || el.className); }
        return 'no search btn';
      })()`);
    console.log('SEARCH:', search);

    await sleep(20000);

    const result = await evalJs(`
      JSON.stringify({ href: location.href, title: document.title, text: document.body.innerText.slice(0, 2000) })`);
    fs.writeFileSync(`${outBase}_result.txt`, result || '');
    fs.writeFileSync(`${outBase}_api.json`, JSON.stringify(apiCalls, null, 2));
    console.log('RESULT HREF:', JSON.parse(result || '{}').href);
    console.log('RESULT TEXT:', (result || '').slice(0, 1600));
    console.log(`API: ${apiCalls.length} -> ${outBase}_api.json`);
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
