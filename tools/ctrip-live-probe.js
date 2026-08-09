// Launch visible Edge, load a Ctrip domestic flight list page, capture the underlying JSON API.
// Usage: node tools/ctrip-live-probe.js <ctrip-list-url> [waitMs]
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitMs = Number(process.argv[3]) || 20000;
const port = 10600 + Math.floor(Math.random() * 80);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
const outBase = path.join(os.tmpdir(), `ctrip_probe_${Date.now()}`);

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
    const requests = [];
    const responses = [];
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
        if (/soa2|itinerary|api|flight|search|12808/i.test(r.url)) {
          requests.push({ url: r.url, method: r.method, postData: r.postData || '', headers: r.headers });
        }
      }
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        if (/soa2|itinerary|api|flight|search|12808/i.test(r.url) && /json/i.test(r.mimeType) && r.status === 200) {
          responses.push({ url: r.url, requestId: msg.params.requestId });
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
    await sleep(waitMs);

    const bodies = [];
    for (const resp of responses) {
      try {
        const b = await send('Network.getResponseBody', { requestId: resp.requestId });
        if (b && b.result) bodies.push({ url: resp.url, body: b.result.body });
      } catch { /* evicted */ }
    }

    fs.mkdirSync(`${outBase}.out`, { recursive: true });
    fs.writeFileSync(`${outBase}.out/requests.json`, JSON.stringify(requests, null, 2));
    fs.writeFileSync(`${outBase}.out/responses.json`, JSON.stringify(bodies, null, 2));
    const page = await evalJs(`JSON.stringify({ href: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 600) })`);
    fs.writeFileSync(`${outBase}.txt`, page || '');

    console.log('URL:', url);
    console.log('requests:', requests.length, 'json bodies:', bodies.length);
    requests.forEach((r) => console.log(`REQ ${r.method} ${r.url.slice(0, 140)} body=${(r.postData || '').slice(0, 200)}`));
    bodies.forEach((b) => {
      const m = b.url.match(/soa2\/(\d+)\/([A-Za-z]+)/) || b.url.match(/(itinerary\/api\/[A-Za-z0-9\/]+)/);
      console.log(`BODY ${m ? m[1] + '/' + m[2] : b.url.slice(0, 90)} len=${b.body.length}: ${b.body.slice(0, 260)}`);
    });
    console.log('PAGE:', (page || '').slice(0, 500));
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
