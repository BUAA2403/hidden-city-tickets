// 探测“选择/预订”按钮点击后跳转的 URL（确认是否支持按航班号/票价深链）。
// 用法: node tools/deeplink-probe.js <url> <等待ms> <点击选择器> <输出前缀> [点击后等待ms]
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitMs = Number(process.argv[3]) || 12000;
const clickSel = process.argv[4] || '';
const prefix = process.argv[5] || 'probe';
const postClickWait = Number(process.argv[6]) || 6000;
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const port = 9800 + Math.floor(Math.random() * 100);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=' + ua,
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
    const netLog = [];
    let send = null;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Page.frameNavigated') {
        netLog.push({ type: 'NAV', url: msg.params.frame.url });
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const r = msg.params.request;
        if (/flight|book|order|detail|flash|api\//i.test(r.url)) {
          netLog.push({ type: 'REQ', url: r.url, method: r.method });
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
    await send('Network.setUserAgentOverride', { userAgent: ua });
    await send('Page.navigate', { url });

    await sleep(waitMs);

    const dump = await send('Runtime.evaluate', {
      expression: `(() => {
        const out = { href: location.href, title: document.title, links: [], scripts: [], clicked: false, afterHref: '' };
        document.querySelectorAll('a').forEach((a) => {
          const h = a.href || '';
          const t = (a.innerText || '').trim().slice(0, 40);
          if (/flight|book|order|detail|flash|itinerary|key=/i.test(h) || /选择|预订|购买|订/i.test(t)) {
            out.links.push({ text: t, href: h });
          }
        });
        document.querySelectorAll('script[src]').forEach((s) => out.scripts.push(s.src));
        return JSON.stringify(out);
      })()`,
      returnByValue: true,
    });
    const info = JSON.parse(dump.result.result.value);

    fs.writeFileSync(`${prefix}.json`, JSON.stringify(info, null, 2));
    fs.writeFileSync(`${prefix}.net.json`, JSON.stringify(netLog, null, 2));

    console.log('URL: ' + info.href);
    console.log('TITLE: ' + info.title);
    console.log('--- LINKS ---');
    (info.links || []).slice(0, 30).forEach((l) => console.log(l.text + ' => ' + l.href));
    console.log('--- SCRIPTS ---');
    (info.scripts || []).slice(0, 30).forEach((s) => console.log(s));

    if (clickSel) {
      const clickRes = await send('Runtime.evaluate', {
        expression: clickSel.startsWith('JS:')
          ? clickSel.slice(3)
          : `(() => {
              const el = document.querySelector(${JSON.stringify(clickSel)});
              if (!el) return 'NOT_FOUND';
              el.scrollIntoView({ block: 'center' });
              el.click();
              return 'CLICKED';
            })()`,
        returnByValue: true,
      });
      console.log('CLICK: ' + clickRes.result.result.value);
      await sleep(postClickWait);
      const after = await send('Runtime.evaluate', {
        expression: `JSON.stringify({ href: location.href, title: document.title })`,
        returnByValue: true,
      });
      const a = JSON.parse(after.result.result.value);
      console.log('AFTER URL: ' + a.href);
      console.log('AFTER TITLE: ' + a.title);
      try {
        const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await listRes.json();
        console.log('--- ALL TARGETS AFTER CLICK ---');
        (list || []).filter((t) => t.type === 'page').forEach((t) => console.log(t.url));
      } catch { /* ignore */ }
      fs.writeFileSync(`${prefix}.after.json`, JSON.stringify({ ...info, after: a, netLog }, null, 2));
    }

    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
