// Trip.com flight search driver: headless Edge + CDP.
// Usage: node tools/trip-search.js [--from=CAN] [--to=PEK] [--date=2026-08-20] [--inspect]
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const args = process.argv.slice(2);
const INSPECT = args.includes('--inspect');
const from = (args.find((a) => a.startsWith('--from=')) || '--from=CAN').split('=')[1];
const to = (args.find((a) => a.startsWith('--to=')) || '--to=PEK').split('=')[1];
const date = (args.find((a) => a.startsWith('--date=')) || '--date=2026-08-20').split('=')[1];
const port = 9800 + Math.floor(Math.random() * 150);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const outBase = path.join(os.tmpdir(), `trip_${from}_${to}_${Date.now()}`);

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
    if (!target) throw new Error('CDP endpoint not ready');

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
        if (/soa2|api|flight|search/i.test(r.url) && r.method === 'POST') {
          apiCalls.push({ method: 'POST', url: r.url, postData: r.postData || '' });
        }
      }
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        if (/soa2|api|flight|search/i.test(r.url) && /json/i.test(r.mimeType) && r.status === 200) {
          send('Network.getResponseBody', { requestId: msg.params.requestId }).then((res) => {
            if (res && res.result) {
              apiCalls.push({ method: 'RESP', url: r.url, body: res.result.body });
            }
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

    const formInfo = await evalJs(`
      JSON.stringify({
        href: location.href,
        inputs: Array.from(document.querySelectorAll('input')).map((e) => ({
          type: e.type, ph: e.placeholder || '', aria: e.getAttribute('aria-label') || '',
          cls: (e.className || '').toString().slice(0, 50), val: (e.value || '').slice(0, 20),
        })),
      })`);
    fs.writeFileSync(`${outBase}_form.json`, formInfo || '');
    console.log('FORM:', (formInfo || '').slice(0, 2000));

    if (INSPECT) { console.log('INSPECT only, exit'); ws.close(); return; }

    const setInput = (value, which) => `
      (function () {
        const inputs = Array.from(document.querySelectorAll('input'));
        const dep = inputs.find((e) => /depart|from|leave/i.test((e.placeholder || '') + ' ' + (e.getAttribute('aria-label') || '')));
        const arr = inputs.find((e) => /arriv|going/i.test((e.placeholder || '') + ' ' + (e.getAttribute('aria-label') || '')));
        const el = ${JSON.stringify(which)} === 'to' ? (arr || inputs[1]) : (dep || inputs[0]);
        if (!el) return 'no input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.focus();
        return 'set(' + ${JSON.stringify(which)} + ') on ' + (el.getAttribute('aria-label') || el.placeholder || el.className);
      })()`;

    const fromSet = await evalJs(setInput(from, 'from'));
    console.log('FROM SET:', fromSet);
    await sleep(2800);

    const suggestInfo = await evalJs(`
      JSON.stringify(Array.from(document.querySelectorAll('div,li,span')).filter((e) => {
        const t = (e.textContent || '').trim();
        return t.length < 70 && new RegExp(${JSON.stringify(from)}).test(t);
      }).map((e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 55), text: e.textContent.trim().slice(0, 60) })).slice(0, 25))`);
    console.log('SUGGEST:', suggestInfo);

    const clickSuggestion = (code) => `
      (function () {
        const all = Array.from(document.querySelectorAll('div,li,span,button,a'));
        const el = all.find((e) => {
          const t = (e.textContent || '').trim();
          return t.length < 55 && t.indexOf('(' + ${JSON.stringify(code)} + ')') !== -1 && e.children.length <= 2;
        });
        if (el) { el.click(); return 'clicked: ' + el.textContent.trim().slice(0, 45); }
        const fb = all.find((e) => {
          const t = (e.textContent || '').trim();
          return t.length < 55 && new RegExp(${JSON.stringify(code)}).test(t) && e.children.length <= 1;
        });
        if (fb) { fb.click(); return 'fallback: ' + fb.textContent.trim().slice(0, 45); }
        return 'none';
      })()`;

    const fromClick = await evalJs(clickSuggestion(from));
    console.log('FROM PICK:', fromClick);
    await sleep(1800);

    const toSet = await evalJs(setInput(to, 'to'));
    console.log('TO SET:', toSet);
    await sleep(2800);
    const toClick = await evalJs(clickSuggestion(to));
    console.log('TO PICK:', toClick);
    await sleep(1800);

    const oneway = await evalJs(`
      (function () {
        const all = Array.from(document.querySelectorAll('div,button,span,a'));
        const el = all.find((e) => {
          const t = (e.textContent || '').trim();
          return /^One-way$/i.test(t) && e.children.length <= 2;
        });
        if (el) { (el.closest('button') || el).click(); return 'oneway clicked'; }
        return 'no oneway';
      })()`);
    console.log('ONEWAY:', oneway);
    await sleep(800);

    const dateSet = await evalJs(`
      (function () {
        const inputs = Array.from(document.querySelectorAll('input'));
        const el = inputs.find((e) => (e.type || '') === 'date') || inputs.find((e) => /date/i.test((e.placeholder || '') + ' ' + (e.getAttribute('aria-label') || ''))) || inputs[2];
        if (!el) return 'no date';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(date)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'date set: ' + (el.value || el.placeholder);
      })()`);
    console.log('DATE:', dateSet);
    await sleep(600);

    const searchClick = await evalJs(`
      (function () {
        const all = Array.from(document.querySelectorAll('button,div,span,a'));
        const el = all.find((e) => {
          const t = (e.innerText || '').trim();
          return /^Search$/.test(t) && e.children.length <= 3 && t.length <= 12;
        });
        if (el) { (el.closest('button') || el).click(); return 'clicked: ' + el.tagName + '.' + ((el.className || '').toString().slice(0, 45)); }
        const f = document.querySelector('form');
        if (f) { f.requestSubmit(); return 'form submit'; }
        return 'none';
      })()`);
    console.log('SEARCH:', searchClick);

    await sleep(18000);

    const resultInfo = await evalJs(`
      JSON.stringify({ href: location.href, title: document.title, text: document.body.innerText.slice(0, 3000) })`);
    fs.writeFileSync(`${outBase}_result.txt`, resultInfo || '');
    fs.writeFileSync(`${outBase}_api.json`, JSON.stringify(apiCalls, null, 2));
    console.log('RESULT URL:', JSON.parse(resultInfo || '{}').href);
    console.log('RESULT TEXT:', (resultInfo || '').slice(0, 2200));
    console.log(`API CALLS: ${apiCalls.length} -> ${outBase}_api.json`);
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
