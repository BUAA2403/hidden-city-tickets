'use strict';

const crypto = require('crypto');
const { mapLimit } = require('./search-workers');
const { candidateTails, getCity, airlineName, isDomestic } = require('./cities');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ENDPOINT = 'https://www.trip.com/restapi/soa2/19866/FlightSelectSearch';
const searchCache = new Map();
const searchCacheTtl = Number(process.env.TRIPCOM_CACHE_TTL_MS) || 30 * 60 * 1000;

function withTimeout(ms, promise) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildHead() {
  const cid = String(Date.now()).padStart(16, '0').slice(-16);
  const fxpcq = '09' + cid;
  return {
    fxpcq,
    head: {
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
    },
  };
}

function cabinToSgrade(cabin) {
  return cabin === 'business' ? 2 : 0; // 0=经济舱 2=公务舱（Trip.com FlightSelectSearch）
}

async function flightSearch(segments, triptype, cabin) {
  const cacheKey = JSON.stringify({ segments, triptype, cabin });
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < searchCacheTtl) return hit.json;
  const { fxpcq, head } = buildHead();
  const body = {
    head,
    platform: { src: 'PC', lang: 'en-XX', currency: 'CNY', sitesrc: 'trip', local: '', uid: '' },
    flightcriteria: {
      osource: 1, triptype, fmap: 3, sflag: 0, rtype: 2,
      seglist: segments.map((s) => ({ ...s, sgrade: cabinToSgrade(cabin) })),
      pinfo: { adults: 1, children: 0, babys: 0 },
    },
  };
  const trace = `${fxpcq}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await withTimeout(15000, fetch(`${ENDPOINT}?_fxpcqlniredt=${fxpcq}&x-traceID=${trace}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      Origin: 'https://www.trip.com',
      Referer: 'https://www.trip.com/flights/',
    },
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw new Error(`trip.com HTTP ${res.status}`);
  const json = await res.json();
  const code = json.sr && json.sr.errcode;
  if (code !== '200' && code !== 200) {
    throw new Error(`trip.com 无结果 (${code})`);
  }
  const ts = Date.now();
  json.fetchedAt = new Date(ts).toISOString();
  searchCache.set(cacheKey, { ts, json });
  return json;
}

function parseGroup(json, dates) {
  let best;
  for (const group of json.grouplist || []) {
    const flights = group.flightlist || [];
    if (flights.length !== dates.length) continue;
    if (flights.some((f, i) => f.dateinfo?.dtime?.slice(0, 10) !== dates[i])) continue;
    const flightNos = flights.map((f) => (f.binfo?.flightno || '').toLowerCase());
    if (flightNos.some((no) => !no)) continue;

    const policies = group.policylist || [];
    const hasTokens = policies.some((p) => p.fgptoken);
    for (const policy of policies) {
      const price = Number(policy.price?.price);
      if (!Number.isFinite(price) || price <= 0 || (best && price >= best.price)) continue;
      if (hasTokens) {
        // 每个报价各自绑定航班。token 的最后一段是价格，前面是航班号、机场与日期。
        const parts = (policy.fgptoken || '').split('&').slice(0, -1);
        if (parts.length !== dates.length || parts.some((part, i) => {
          const [no, , , date] = part.split('|');
          return no.toLowerCase() !== flightNos[i] || date !== dates[i];
        })) continue;
      }
      best = { flights, price };
    }
  }
  if (!best) return null;

  const legs = best.flights.map((f, i) => ({
    airline: f.binfo && f.binfo.aircode,
    airlineName: (f.binfo && f.binfo.airlineName) || airlineName(f.binfo && f.binfo.aircode) || '',
    flightNo: f.binfo && f.binfo.flightno,
    from: { code: f.dportinfo && f.dportinfo.city, city: f.dportinfo && f.dportinfo.cname, airport: (f.dportinfo && f.dportinfo.airname) || '' },
    to: { code: f.aportinfo && f.aportinfo.city, city: f.aportinfo && f.aportinfo.cname, airport: (f.aportinfo && f.aportinfo.airname) || '' },
    depTime: (f.dateinfo && f.dateinfo.dtime || '').slice(11, 16),
    arrTime: (f.dateinfo && f.dateinfo.atime || '').slice(11, 16),
    durationMin: f.binfo && f.binfo.duration,
    date: dates[i],
  }));
  return { legs, price: best.price, fetchedAt: json.fetchedAt };
}

function fmtSeg(code, date) {
  return { segno: 1, ddate: date, sgrade: 0, dcode: code.dep, acode: code.arr };
}

// 国际航线实时搜索（Trip.com FlightSelectSearch，纯 HTTP）
async function tryTripcom(query, cabin) {
  const { from, to, date } = query;
  if (isDomestic(from.code, to.code)) return null; // 国内航线不走此接口

  const directJson = await flightSearch([{ segno: 1, ddate: date, dcode: from.code, acode: to.code }], 1, cabin);
  const direct = parseGroup(directJson, [date]);
  if (!direct) throw new Error(`${date} 直飞无可核对报价`);
  const directBest = {
    ...direct.legs[0],
    price: direct.price,
    fetchedAt: direct.fetchedAt,
  };

  const deals = [];
  const seen = new Set();
  const limit = Number(process.env.TRIPCOM_TAILS_LIMIT) || 18;
  const uniqueTails = candidateTails(from, to, 'all', limit);
  const tailResults = await mapLimit(uniqueTails, 3, async (tail) => {
    try {
      const json = await flightSearch([
        { segno: 1, ddate: date, dcode: from.code, acode: to.code },
        { segno: 2, ddate: date, dcode: to.code, acode: tail.code },
      ], 2, cabin);
      const through = parseGroup(json, [date, date]);
      if (!through) return null;
      const key = `${through.legs[0].flightNo}-${through.legs[1].flightNo}`;
      return { through, key };
    } catch { return null; }
  }, Date.now() + 48000);
  const pricedTails = tailResults.filter(Boolean).sort((a, b) => a.through.price - b.through.price);
  for (const item of pricedTails) {
    const { through, key } = item;
    if (seen.has(key)) continue;
    seen.add(key);
    const price = through.price;
    const save = directBest.price - price;
    if (save <= 0) continue;
    const layover = timeDiff(through.legs[0].arrTime, through.legs[1].depTime);
    deals.push({
      id: key,
      rank: 0,
      dealType: 'hidden',
      source: 'tripcom',
      totalPrice: price,
      fetchedAt: through.fetchedAt,
      directPrice: directBest.price,
      saveAmount: save,
      savePercent: Math.round((save / directBest.price) * 1000) / 10,
      layoverMin: layover,
      legs: through.legs,
      skip: `${through.legs[1].to.code} ${through.legs[1].to.city}`,
      skipCity: through.legs[1].to.city,
      tip: `买 ${from.city}→${to.city}→${through.legs[1].to.city} 全程票，只在 ${to.city} 下机，不坐后续 ${through.legs[1].to.city} 段`,
    });
  }

  // 往返甩返程：国际航线往返常比单程便宜（买往返，只用去程）
  const rt = await bestRoundTrip(from, to, date, directBest.price, cabin);
  if (rt) {
    const save = directBest.price - rt.price;
    if (save > 0) {
      deals.push({
        id: `rt-${from.code}-${to.code}-${rt.returnDate}`,
        rank: 0,
        dealType: 'roundtrip',
        source: 'tripcom',
        totalPrice: rt.price,
        fetchedAt: rt.fetchedAt,
        directPrice: directBest.price,
        saveAmount: save,
        savePercent: Math.round((save / directBest.price) * 1000) / 10,
        layoverMin: 0,
        legs: rt.legs,
        skip: `返程 ${rt.legs[1] ? rt.legs[1].to.city : ''} 段`,
        skipCity: rt.legs[1] ? rt.legs[1].to.city : '返程',
        returnDate: rt.returnDate,
        tip: `买 ${from.city}→${to.city} 往返票（${date} 去 / ${rt.returnDate} 返），只坐去程，不坐返程。往返总价 ${rt.price} 元，比单程 ${directBest.price} 元还便宜。`,
      });
    }
  }
  deals.sort((a, b) => b.saveAmount - a.saveAmount);
  deals.forEach((d, i) => (d.rank = i + 1));

  return {
    query: {
      from: { code: from.code, city: from.city, airport: from.airport },
      to: { code: to.code, city: to.city, airport: to.airport },
      date,
    },
    direct: {
      best: directBest,
      options: [directBest],
      source: 'tripcom',
    },
    deals: deals.slice(0, 8),
    emptyReason: deals.length ? null : `已尝试 ${tailResults.filter((r) => r !== undefined).length} 个候选城市及往返组合。返回的同日可比报价中未找到低于直飞的方案。`,
  };
}

async function bestRoundTrip(from, to, date, oneWayPrice, cabin) {
  let best = null;
  const deltas = [7, 14];
  const results = await mapLimit(deltas, 3, async (delta) => {
    const returnDate = addDays(date, delta);
    try {
      const j = await flightSearch([
        { segno: 1, ddate: date, dcode: from.code, acode: to.code },
        { segno: 2, ddate: returnDate, dcode: to.code, acode: from.code },
      ], 2, cabin);
      const g = parseGroup(j, [date, returnDate]);
      return g ? { ...g, returnDate } : null;
    } catch { return null; }
  });
  for (const r of results) {
    if (!r) continue;
    if (!best || r.price < best.price) best = r;
  }
  return best;
}

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 混合联程：国内第一段 + 国际尾巴（用于“国内飞国内甩国际段”）
async function tripcomMixed(query, tailCode, cabin) {
  const { from, to, date } = query;
  const j = await flightSearch([
    { segno: 1, ddate: date, dcode: from.code, acode: to.code },
    { segno: 2, ddate: date, dcode: to.code, acode: tailCode },
  ], 2, cabin);
  const g = parseGroup(j, [date, date]);
  return g ? { ...g, tail: getCity(tailCode) } : null;
}

function timeDiff(a, b) {
  if (!a || !b) return 0;
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  let d = toMin(b) - toMin(a);
  if (d < 0) d += 24 * 60;
  return d;
}

async function trySkyscanner() {
  return null; // 需要 SKYSCANNER_API_KEY，未配置时跳过
}

module.exports = { tryTripcom, trySkyscanner, flightSearch, tripcomMixed };
