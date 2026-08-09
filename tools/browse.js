// 浏览器探测/抓包工具：无头 Edge + CDP 打开页面，抓取渲染后的文本与网络请求。
// 用法: node tools/browse.js <url> <等待毫秒> <输出前缀> [User-Agent]
// 输出: <前缀>.txt (页面文本) / <前缀>.net.json (网络日志) / <前缀>.body/*.json (响应体)
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const waitMs = Number(process.argv[3]) || 12000;
const prefix = process.argv[4] || 'browse';
const ua = process.argv[5] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
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
    if (!target) throw new Error('CDP endpoint 未就绪');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const netLog = [];
    const bodies = [];
    let send = null;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        netLog.push({
          url: r.url,
          status: r.status,
          mime: r.mimeType,
          type: msg.params.type,
        });
        if (/json|soa2|api\/|batch|flight|search/i.test(r.url) && /json|text/i.test(r.mimeType) && r.status === 200) {
          send('Network.getResponseBody', { requestId: msg.params.requestId }).then((res) => {
            if (res && res.result) {
              bodies.push({ url: r.url, body: res.result.body, base64: res.result.base64Encoded });
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

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable', {});
    await send('Network.setUserAgentOverride', { userAgent: ua });
    await send('Page.navigate', { url });

    await sleep(waitMs);

    const evalRes = await send('Runtime.evaluate', {
      expression: `JSON.stringify({title: document.title, href: location.href, text: document.body ? document.body.innerText.slice(0, 4000) : ''})`,
      returnByValue: true,
    });
    const info = JSON.parse(evalRes.result.result.value);

    fs.writeFileSync(`${prefix}.txt`, `URL: ${info.href}\nTITLE: ${info.title}\n\n${info.text}`);
    fs.writeFileSync(`${prefix}.net.json`, JSON.stringify(netLog, null, 2));
    fs.mkdirSync(`${prefix}.body`, { recursive: true });
    bodies.forEach((b, i) => {
      const safe = b.url.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
      fs.writeFileSync(`${prefix}.body/${i}_${safe}.json`, b.base64 ? Buffer.from(b.body, 'base64') : b.body);
    });

    console.log(`URL: ${info.href}`);
    console.log(`网络请求: ${netLog.length}, JSON 响应体: ${bodies.length}`);
    console.log('页面文本前 800 字:');
    console.log(info.text.slice(0, 800));
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
