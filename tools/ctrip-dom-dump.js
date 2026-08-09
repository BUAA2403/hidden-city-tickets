// Dump the DOM structure of Ctrip flight list cards for scraper development.
// Usage: node tools/ctrip-dom-dump.js <list-url>
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const port = 10800 + Math.floor(Math.random() * 80);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const proc = spawn(EDGE, [
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--no-first-run', '--disable-extensions',
    '--start-maximized',
    url,
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 90 && !target; i++) {
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
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
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

    // wait for actual flight cards (text contains 订票)
    let found = false;
    for (let i = 0; i < 55; i++) {
      await sleep(800);
      const has = await evalJs(`/订票/.test(document.body ? document.body.innerText : '')`);
      if (has) { found = true; break; }
    }
    console.log('flight cards rendered:', found);
    const pageInfo = await evalJs(`JSON.stringify({ href: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 900) })`);
    console.log('PAGE:', pageInfo);
    const dump = await evalJs(`
      (function () {
        const all = Array.from(document.querySelectorAll('*'));
        const withText = all.filter((e) => /订票/.test(e.textContent || '')).length;
        const ticketBtns = all.filter((e) => /订票/.test((e.textContent || '').trim()) && e.children.length <= 2).slice(0, 6);
        window.__ticketCount = ticketBtns.length;
        const cards = ticketBtns.map((b) => {
          let el = b;
          const chain = [];
          for (let i = 0; i < 7 && el; i++) {
            chain.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 90), text: (el.innerText || '').slice(0, 260) });
            el = el.parentElement;
          }
          return chain;
        });
        return JSON.stringify({ withText, cards });
      })()`);
    fs.writeFileSync(path.join(os.tmpdir(), 'ctrip_dom_dump.json'), dump || '');
    console.log('saved to', path.join(os.tmpdir(), 'ctrip_dom_dump.json'));
    const parsed = JSON.parse(dump || '{"withText":0,"cards":[]}');
    console.log('elements with 订票 text:', parsed.withText, '| cards:', parsed.cards.length);
    parsed.cards.forEach((c, i) => {
      console.log('===== CARD', i, 'class:', c.cls);
      c.forEach((cc, j) => console.log(' ', j, cc.tag, '|', cc.cls, '|', cc.text.replace(/\n+/g, ' / ').slice(0, 220)));
    });
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
