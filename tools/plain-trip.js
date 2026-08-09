// Test FlightSelectSearch from plain Node HTTP (no browser), reusing homepage cookies.
// Usage: node tools/plain-trip.js [--from=SIN] [--to=HKG] [--date=2026-08-20]
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const args = process.argv.slice(2);
const from = (args.find((a) => a.startsWith('--from=')) || '--from=SIN').split('=')[1];
const to = (args.find((a) => a.startsWith('--to=')) || '--to=HKG').split('=')[1];
const date = (args.find((a) => a.startsWith('--date=')) || '--date=2026-08-20').split('=')[1];

function cookieString(setCookies) {
  const parts = [];
  for (const sc of setCookies || []) {
    const name = sc.split('=')[0];
    if (/^(FVP|_fxpcq|MKT|aid|union|hm_guid|NQ|B_ID|QN)/i.test(name)) {
      parts.push(sc.split(';')[0]);
    }
  }
  return parts.join('; ');
}

async function main() {
  // 1) 拿首页 cookies（FVP 等）
  const home = await fetch('https://www.trip.com/', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
    redirect: 'manual',
  });
  const cookies = cookieString(home.headers.getSetCookie && home.headers.getSetCookie());
  console.log('home status:', home.status, 'cookies:', cookies.slice(0, 120));

  // 2) 构造 FlightSelectSearch
  const cid = String(Date.now()).padStart(16, '0').slice(-16);
  const fxpcq = '09' + cid;
  const trace = fxpcq + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const head = {
    cid: fxpcq, ctok: '', cver: '1.0', lang: '01', sid: '8888', syscode: '09', auth: '', xsid: '',
    extension: [
      { name: 'locale', value: 'en-XX' },
      { name: 'currency', value: 'CNY' },
      { name: 'sotpLocale', value: 'en-XX' },
      { name: 'sotpCurrency', value: 'CNY' },
      { name: 'sotpGroup', value: 'trip' },
      { name: 'PageId', value: '10650136628' },
      { name: 'productLine', value: 'FlightOnly' },
      { name: 'source', value: 'ONLINE' },
      { name: 'vid', value: '' },
      { name: 'allianceID', value: '0' },
      { name: 'sid', value: '0' },
      { name: 'ouid', value: '' },
      { name: 'flt_app_session_transactionId', value: '1-mf-' + Date.now() + '-WEB' },
      { name: 'useDistributionType', value: '1' },
    ],
    Locale: 'en-XX', Language: 'en', Currency: 'CNY', ClientID: fxpcq,
  };
  const body = {
    head,
    platform: { src: 'PC', lang: 'en-XX', currency: 'CNY', sitesrc: 'trip', local: '', uid: '' },
    flightcriteria: {
      osource: 1, triptype: 1, fmap: 3, sflag: 0, rtype: 2,
      seglist: [{ segno: 1, ddate: date, sgrade: 0, dcode: from, acode: to }],
      pinfo: { adults: 1, children: 0, babys: 0 },
    },
  };

  const res = await fetch(`https://www.trip.com/restapi/soa2/19866/FlightSelectSearch?_fxpcqlniredt=${fxpcq}&x-traceID=${trace}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      Origin: 'https://www.trip.com',
      Referer: 'https://www.trip.com/flights/',
      Cookie: cookies,
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  console.log('search status:', res.status, 'len:', txt.length);
  let brief = txt.slice(0, 500);
  try {
    const j = JSON.parse(txt);
    const f = j.grouplist && j.grouplist[0] && j.grouplist[0].flightlist;
    brief = JSON.stringify({ rt: j.sr && j.sr.rt, errcode: j.sr && j.sr.errcode, errmsg: j.sr && j.sr.errmsg, rcount: j.rcount, flights: f ? f.length : 0, first: f && f[0] && f[0].binfo && f[0].binfo.flightno });
  } catch {}
  console.log(brief);
}

main().catch((e) => { console.error(e); process.exit(1); });
