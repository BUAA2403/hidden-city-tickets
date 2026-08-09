// 探测同程航班页切换“公务舱”后 getpricecalendar / getflightlist 的请求参数。
// 用法: node tools/cabin-probe.js <url> <等待ms> <输出前缀>
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitMs = Number(process.argv[3]) || 16000;
const prefix = process.argv[4] || 'cabin';
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const port = 9600 + Math.floor(Math.random() * 300);
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
    if (!target) throw new Error('CDP endpoint not ready');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const posts = [];
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
        if (/getpricecalendar|getflightlist|FlightMiddleSearch|FlightSelectSearch|19866|27015/i.test(r.url) && r.method === 'POST' && r.postData) {
          posts.push({ url: r.url, headers: r.headers, postData: r.postData });
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

    // 找包含“经济舱/公务舱”文案的可见元素
    const dump = await send('Runtime.evaluate', {
      expression: `(() => {
        const out = { els: [], bodySample: '' };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = walker.nextNode())) {
          const t = (n.innerText || '').trim();
          if (t === '经济舱' || t === '公务舱' || t === '头等舱') {
            const r = n.getBoundingClientRect();
            out.els.push({ tag: n.tagName, cls: n.className, text: t, x: Math.round(r.x), y: Math.round(r.y), visible: r.width > 0 && r.height > 0 });
          }
        }
        return JSON.stringify(out);
      })()`,
      returnByValue: true,
    });
    const info = JSON.parse(dump.result.result.value);
    console.log('cabin elements:', JSON.stringify(info.els));
    fs.writeFileSync(`${prefix}.elements.json`, JSON.stringify(info, null, 2));

    // 点“公务舱”（取第一个可见的）
    const click = await send('Runtime.evaluate', {
      expression: `(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = walker.nextNode())) {
          const t = (n.innerText || '').trim();
          if (t === '公务舱') {
            const r = n.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { n.click(); return 'CLICKED:' + n.tagName + '.' + n.className; }
          }
        }
        return 'NOT_FOUND';
      })()`,
      returnByValue: true,
    });
    console.log('click result:', click.result.result.value);
    await sleep(1200);

    // 尝试点搜索按钮（文本含“搜索”或“查询”的可见按钮/链接）
    const search = await send('Runtime.evaluate', {
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('button, a, div, span')).filter((b) => {
          const t = (b.innerText || '').trim();
          return (t === '搜索' || t === '查询' || t === '机票搜索') && b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0 && b.offsetParent !== null;
        });
        if (btns.length) { btns[0].click(); return 'CLICKED:' + btns[0].tagName + '.' + btns[0].className; }
        return 'NO_BTN';
      })()`,
      returnByValue: true,
    });
    console.log('search click:', search.result.result.value);

    await sleep(6000);
    console.log('captured posts:', posts.length);
    posts.forEach((p, i) => {
      console.log('--- POST ' + i + ' ' + p.url);
      console.log('headers:', JSON.stringify(p.headers).slice(0, 400));
      console.log(p.postData.slice(0, 700));
    });
    fs.writeFileSync(`${prefix}.posts.json`, JSON.stringify(posts, null, 2));
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
