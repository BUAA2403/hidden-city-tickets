// Try FlightSelectSearch variants for domestic CN routes (CAN->PEK etc).
// Usage: node tools/replay-domestic.js [--from=CAN] [--to=PEK] [--date=2026-08-20]
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
const date = (args.find((a) => a.startsWith('--date=')) || '--date=2026-08-20').split('=')[1];
const port = 10100 + Math.floor(Math.random() * 80);
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
    let send = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
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

    const cid = String(Date.now()).padStart(16, '0').slice(-16);
    const fxpcq = '09' + cid;
    const trace = fxpcq + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

    const baseHead = (locale, currency, productLine, sitesrc) => ({
      cid: fxpcq, ctok: '', cver: '1.0', lang: '01', sid: '8888', syscode: '09', auth: '', xsid: '',
      extension: [
        { name: 'locale', value: locale },
        { name: 'currency', value: currency },
        { name: 'sotpLocale', value: locale },
        { name: 'sotpCurrency', value: currency },
        { name: 'sotpGroup', value: 'trip' },
        { name: 'PageId', value: '10650136628' },
        { name: 'productLine', value: productLine },
        { name: 'source', value: 'ONLINE' },
        { name: 'vid', value: '' },
        { name: 'allianceID', value: '0' },
        { name: 'sid', value: '0' },
        { name: 'ouid', value: '' },
        { name: 'flt_app_session_transactionId', value: '1-mf-' + Date.now() + '-WEB' },
        { name: 'useDistributionType', value: '1' },
      ],
      Locale: locale, Language: locale.startsWith('zh') ? 'zh' : 'en', Currency: currency, ClientID: fxpcq,
    });

    const variants = [
      { label: 'CNY/zh-CN/FlightOnly/siteTrip', locale: 'zh-CN', currency: 'CNY', productLine: 'FlightOnly', sitesrc: 'trip', fmap: 3, extra: {} },
      { label: 'CNY/zh-CN/Flight/siteTrip', locale: 'zh-CN', currency: 'CNY', productLine: 'Flight', sitesrc: 'trip', fmap: 3, extra: {} },
      { label: 'CNY/en-XX/FlightOnly/siteCtrip', locale: 'en-XX', currency: 'CNY', productLine: 'FlightOnly', sitesrc: 'ctrip', fmap: 3, extra: {} },
      { label: 'CNY/zh-CN/FlightOnly/isdomestic', locale: 'zh-CN', currency: 'CNY', productLine: 'FlightOnly', sitesrc: 'trip', fmap: 3, extra: { isdomestic: 1 } },
      { label: 'CNY/zh-CN/FlightOnly/fmap1', locale: 'zh-CN', currency: 'CNY', productLine: 'FlightOnly', sitesrc: 'trip', fmap: 1, extra: {} },
      { label: 'CNY/zh-CN/FlightHotel/PEK', locale: 'zh-CN', currency: 'CNY', productLine: 'FlightHotel', sitesrc: 'trip', fmap: 3, extra: {}, hotel: true },
    ];

    for (const v of variants) {
      const head = baseHead(v.locale, v.currency, v.productLine, v.sitesrc);
      const body = {
        head,
        platform: { src: 'PC', lang: v.locale, currency: v.currency, sitesrc: v.sitesrc, local: '', uid: '' },
        flightcriteria: {
          osource: 1, triptype: 1, fmap: v.fmap, sflag: 0, rtype: 2,
          seglist: [{ segno: 1, ddate: date, sgrade: 0, dcode: from, acode: to, ...v.extra }],
          pinfo: { adults: 1, children: 0, babys: 0 },
        },
      };
      if (v.hotel) body.hotelcriteria = { chin: date, chout: date, hcityid: '1', rnum: 1 };

      const expr = `
        (async () => {
          try {
            const res = await fetch('/restapi/soa2/19866/FlightSelectSearch?_fxpcqlniredt=${fxpcq}&x-traceID=${trace}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json;charset=UTF-8' },
              body: ${JSON.stringify(JSON.stringify(body))},
            });
            const txt = await res.text();
            let brief = txt;
            try {
              const j = JSON.parse(txt);
              brief = JSON.stringify({ rt: j.sr && j.sr.rt, errcode: j.sr && j.sr.errcode, errmsg: j.sr && j.sr.errmsg, rcount: j.rcount, first: j.grouplist && j.grouplist[0] && j.grouplist[0].flightlist && j.grouplist[0].flightlist[0] && { no: j.grouplist[0].flightlist[0].binfo.flightno, price: j.grouplist[0].flightlist[0].price } });
            } catch {}
            return JSON.stringify({ status: res.status, brief, len: txt.length });
          } catch (e) {
            return JSON.stringify({ status: 0, brief: 'ERR ' + e.message });
          }
        })()`;
      const out = await evalJs(expr);
      console.log('=== ' + v.label + ' ===');
      console.log(out);
      await sleep(350);
    }
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
