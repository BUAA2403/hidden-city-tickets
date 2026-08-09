// Replay Ctrip batchSearch inside a real browser session using the page's own headers.
// Usage: node tools/ctrip-replay.js [--from=CAN] [--to=PEK] [--date=2026-08-20]
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const args = process.argv.slice(2);
const from = (args.find((a) => a.startsWith('--from=')) || '--from=CAN').split('=')[1];
const to = (args.find((a) => a.startsWith('--to=')) || '--to=PEK').split('=')[1];
const date = (args.find((a) => a.startsWith('--date=')) || '--date=2026-08-20').split('=')[1];
const port = 10700 + Math.floor(Math.random() * 80);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'edgecdp-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function buildCall(dep, arrCity, arrAirport, depName, arrName, capturedHeaders, date, mode) {
  const tid = crypto.randomUUID().replace(/-/g, '');
  const sign = md5(tid + dep + arrCity + date);
  const bodyObj = {
    adultCount: 1, childCount: 0, infantCount: 0, flightWay: 'S', cabin: 'Y_S', scope: 'd', segmentNo: 1,
    transactionID: tid,
    flightSegments: [{
      departureCityCode: dep, arrivalCityCode: arrCity, arrivalAirportCode: arrAirport,
      departureCityName: depName, arrivalCityName: arrName,
      departureDate: date,
      departureCountryId: 1, departureCountryName: '中国', departureCountryCode: 'CN', departureProvinceId: 23, departureCityId: 32,
      arrivalCountryId: 1, arrivalCountryName: '中国', arrivalProvinceId: 1, arrivalCityId: 1,
      arrivalAirportName: arrName, departureCityTimeZone: 480, arrivalCityTimeZone: 480, timeZone: 480,
    }],
    directFlight: false,
    extGlobalSwitches: { useAllRecommendSwitch: true, unfoldPriceListSwitch: true },
    noRecommend: false,
    extensionAttributes: { LoggingSampling: false, isFlightIntlNewUser: false },
  };
  const bodyJson = JSON.stringify(bodyObj);
  const h = { ...capturedHeaders };
  delete h['sec-ch-ua']; delete h['sec-ch-ua-mobile']; delete h['sec-ch-ua-platform'];
  delete h['Rms-Token']; delete h['Cache-Control']; delete h['cookieOrigin'];
  if (mode === 'clean') {
    delete h['w-payload-source'];
    delete h['x-ctx-ubt-vid']; delete h['x-ctx-ubt-pvid']; delete h['x-ctx-ubt-sid']; delete h['x-ctx-ubt-pageid'];
    delete h['cookieOrigin'];
  }
  if (mode === 'all') {
    // keep everything, only remove browser-forbidden ones
  }
  h.transactionID = tid;
  h.sign = sign;

  return `
    (async () => {
      try {
        const body = ${JSON.stringify(bodyJson)};
        const h = ${JSON.stringify(h)};
        const res = await fetch('/international/search/api/search/batchSearch?v=' + Math.random(), {
          method: 'POST', headers: h, body,
        });
        const txt = await res.text();
        try {
          const j = JSON.parse(txt);
          const list = (j.data && j.data.flightItineraryList) || [];
          const mins = list.map((it) => Math.min(...(it.priceList || []).map((p) => p.adultPrice || 0))).filter((x) => x > 0);
          return JSON.stringify({ status: res.status, code: j.code, msg: (j.msg || '').slice(0, 120), count: list.length, minPrice: mins.length ? Math.min(...mins) : 0, dkeys: Object.keys(j.data || {}).join(','), raw: txt.slice(0, 220) });
        } catch {
          return JSON.stringify({ status: res.status, raw: txt.slice(0, 300) });
        }
      } catch (e) {
        return JSON.stringify({ err: String(e) });
      }
    })()`;
}

async function main() {
  const proc = spawn(EDGE, [
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--no-first-run', '--disable-extensions',
    '--start-maximized',
    `https://flights.ctrip.com/online/list/oneway-${from}-${to}?depdate=${date}`,
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
    let captured = null;
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
        if (/batchSearch/.test(r.url) && !captured) {
          captured = { url: r.url, headers: r.headers, postData: r.postData };
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
      if (r.result && r.result.exceptionDetails) {
        return 'EXCEPTION: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text);
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable', {});
    await sleep(16000);

    if (!captured) throw new Error('no batchSearch captured');
    console.log('captured batchSearch for', from, '->', to, '| token:', !!captured.headers.token, '| w-payload:', !!captured.headers['w-payload-source']);

    const r1 = await evalJs(buildCall('CAN', 'CGQ', 'CGQ', '广州', '长春', captured.headers, date, 'clean'));
    console.log('REPLAY clean CAN->CGQ:', r1);
    const r2 = await evalJs(buildCall('CAN', 'CGQ', 'CGQ', '广州', '长春', captured.headers, date, 'full'));
    console.log('REPLAY full CAN->CGQ:', r2);
    const r3 = await evalJs(buildCall('CAN', 'BJS', 'PEK', '广州', '北京', captured.headers, date, 'clean'));
    console.log('REPLAY clean CAN->PEK:', r3);
    const r4 = await evalJs(buildCall('CAN', 'BJS', 'PEK', '广州', '北京', captured.headers, date, 'all'));
    console.log('REPLAY all CAN->PEK:', r4);
    ws.close();
  } finally {
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
