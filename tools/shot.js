// QA 工具：用无头 Edge + CDP 打开页面，等待指定选择器出现后截图。
// 用法: node tools/shot.js <url> <输出png> [等待的选择器，默认 .deal-card]
// 例:   node tools/shot.js "http://localhost:3000/?from=CAN&to=PEK" shot.png ".deal-card"
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const selector = process.argv[4] || '.deal-card';
const port = 9400 + Math.floor(Math.random() * 400);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
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
    if (!target) throw new Error('CDP endpoint 未就绪');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url });

    let found = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const r = await send('Runtime.evaluate', {
        expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`,
        returnByValue: true,
      });
      const n = r.result && r.result.result && r.result.result.value;
      if (Number(n) > 0) { found = true; break; }
    }
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (!shot.result || !shot.result.data) throw new Error('截图失败');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`saved: ${out} (${found ? 'selector 已出现' : 'selector 未出现: ' + selector})`);
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
