// 布局探测：打开本地页面，等 .deal-card 出现后输出卡片及子元素的几何信息。
// 用法: node tools/layout-probe.js <url> <等待ms> [选择器]
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitMs = Number(process.argv[3]) || 18000;
const selector = process.argv[4] || '.deal-card';
const vw = Number(process.env.PROBE_WIDTH) || 1440;
const port = 9700 + Math.floor(Math.random() * 100);
const userData = fs_mkdtemp();

function fs_mkdtemp() {
  const fs = require('fs');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));
}

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
    await send('Emulation.setDeviceMetricsOverride', { width: vw, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });

    let found = false;
    for (let i = 0; i < Math.ceil(waitMs / 300); i++) {
      await sleep(300);
      const r = await send('Runtime.evaluate', {
        expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`,
        returnByValue: true,
      });
      if (Number(r.result && r.result.result && r.result.result.value) > 0) { found = true; break; }
    }

    const expr = `(() => {
      const out = { win: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, cards: [] };
      document.querySelectorAll('.deal-card').forEach((card, ci) => {
        const cs = getComputedStyle(card);
        const kids = [];
        const flightRows = [];
        Array.from(card.children).forEach((k) => {
          const r = k.getBoundingClientRect();
          const kcs = getComputedStyle(k);
          kids.push({ tag: k.tagName, cls: k.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: kcs.display, flex: kcs.flexDirection, grid: kcs.gridTemplateColumns });
        });
        card.querySelectorAll('.flight-row').forEach((fr) => {
          const frr = fr.getBoundingClientRect();
          flightRows.push({ x: Math.round(frr.x), y: Math.round(frr.y), w: Math.round(frr.width), h: Math.round(frr.height), scrollW: fr.scrollWidth, wrap: getComputedStyle(fr).flexWrap });
        });
        const cr = card.getBoundingClientRect();
        out.cards.push({ i: ci, x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height), display: cs.display, grid: cs.gridTemplateColumns, alignItems: cs.alignItems, gap: cs.gap, kids, flightRows });
      });
      return JSON.stringify(out);
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    }
    console.log(r.result && r.result.result && r.result.result.value !== undefined ? r.result.result.value : JSON.stringify(r.result));
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
