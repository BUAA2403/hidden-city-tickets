// Probe a URL and dump every POST body + JSON response body (esp. soa2/19866).
// Usage: node tools/probe-api.js <url> <waitMs> <outPrefix>
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const url = process.argv[2];
const waitMs = Number(process.argv[3]) || 15000;
const prefix = process.argv[4] || 'probe';
const port = 9700 + Math.floor(Math.random() * 200);
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
        if (/soa2|19866|flight|search/i.test(r.url)) {
          requests.push({ url: r.url, method: r.method, postData: r.postData || '', headers: r.headers });
        }
      }
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        if (/soa2|19866|flight|search/i.test(r.url) && /json|text/i.test(r.mimeType) && r.status === 200) {
          responses.push({ url: r.url, requestId: msg.params.requestId });
        }
      }
    };

    send = (method, params = {}) => new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable', {});
    await send('Network.setUserAgentOverride', { userAgent: UA });
    await send('Page.navigate', { url });
    await sleep(waitMs);

    const bodies = [];
    for (const resp of responses) {
      try {
        const b = await send('Network.getResponseBody', { requestId: resp.requestId });
        if (b && b.result) bodies.push({ url: resp.url, body: b.result.body });
      } catch { /* evicted */ }
    }

    fs.mkdirSync(`${prefix}.out`, { recursive: true });
    fs.writeFileSync(`${prefix}.out/requests.json`, JSON.stringify(requests, null, 2));
    fs.writeFileSync(`${prefix}.out/responses.json`, JSON.stringify(bodies, null, 2));

    console.log(`requests: ${requests.length}, json bodies: ${bodies.length}`);
    requests.forEach((r) => console.log(`POST ${r.method} ${r.url.slice(0, 150)} body=${(r.postData || '').slice(0, 300)}`));
    bodies.forEach((b) => {
      const name = b.url.match(/soa2\/(\d+)\/([A-Za-z]+)/);
      console.log(`BODY ${name ? name[1] + '/' + name[2] : b.url.slice(0, 80)}: ${b.body.slice(0, 400)}`);
    });
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
