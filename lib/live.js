'use strict';

const { continuationsFor, internationalTailsFor, getCity, airlineName, isDomestic } = require('./cities');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ENDPOINT = 'https://www.trip.com/restapi/soa2/19866/FlightSelectSearch';
const searchCache = new Map();
const searchCacheTtl = Number(process.env.TRIPCOM_CACHE_TTL_MS) || 30 * 60 * 1000;

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

async function flightSearch(segments, triptype, cabin, timeoutMs = 15000) {
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
  const res = await fetch(`${ENDPOINT}?_fxpcqlniredt=${fxpcq}&x-traceID=${trace}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      Origin: 'https://www.trip.com',
      Referer: 'https://www.trip.com/flights/',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`trip.com HTTP ${res.status}`);
  const json = await res.json();
  const code = json.sr && json.sr.errcode;
  if (code !== '200' && code !== 200) {
    throw new Error(`trip.com 无结果 (${code})`);
  }
  searchCache.set(cacheKey, { ts: Date.now(), json });
  return json;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function matchesPort(port, code) {
  return port?.aport === code || port?.city === code;
}

function parseGroup(group, segments) {
  const flights = group.flightlist || [];
  if (flights.length !== segments.length || !flights.every((f, i) =>
    f.binfo?.flightno &&
    matchesPort(f.dportinfo, segments[i].dcode) &&
    matchesPort(f.aportinfo, segments[i].acode) &&
    f.dateinfo?.dtime?.slice(0, 10) === segments[i].ddate
  )) return null;
  const layoverMin = flights.length === 2
    ? timeDiff(flights[0].dateinfo.atime, flights[1].dateinfo.dtime)
    : null;
  if (layoverMin !== null && layoverMin < 0) return null;

  const policies = group.policylist || [];
  const hasTokens = policies.some((p) => p.fgptoken);
  const flightNos = flights.map((f) => f.binfo.flightno.toLowerCase());
  // 每个价格都要与自己的航班组合匹配。
  const prices = policies.filter((p) => {
    if (!hasTokens) return true;
    const tokenNos = (p.fgptoken || '').toLowerCase().split('&').slice(0, -1).map((part) => part.split('|')[0]);
    return tokenNos.length === flightNos.length && tokenNos.every((no, i) => no === flightNos[i]);
  }).map((p) => Number(p.price?.price)).filter((price) => Number.isFinite(price) && price > 0);
  if (!prices.length) return null;

  const legs = flights.map((f) => ({
    airline: f.binfo && f.binfo.aircode,
    airlineName: (f.binfo && f.binfo.airlineName) || airlineName(f.binfo && f.binfo.aircode) || '',
    flightNo: f.binfo && f.binfo.flightno,
    from: { code: f.dportinfo.aport || f.dportinfo.city, city: f.dportinfo.cname, airport: f.dportinfo.airname || '' },
    to: { code: f.aportinfo.aport || f.aportinfo.city, city: f.aportinfo.cname, airport: f.aportinfo.airname || '' },
    depTime: (f.dateinfo && f.dateinfo.dtime || '').slice(11, 16),
    arrTime: (f.dateinfo && f.dateinfo.atime || '').slice(11, 16),
    durationMin: Number(f.binfo.duration) || 0,
    date: f.dateinfo.dtime.slice(0, 10),
  }));
  return { legs, layoverMin, price: Math.min(...prices) };
}

async function bestItinerary(segments, triptype, cabin, timeoutMs) {
  const json = await flightSearch(segments, triptype, cabin, timeoutMs);
  let best = null;
  for (const group of json.grouplist || []) {
    const offer = parseGroup(group, segments);
    if (offer && (!best || offer.price < best.price)) best = offer;
  }
  return best;
}

// 国际航线实时搜索（Trip.com FlightSelectSearch，纯 HTTP）
async function tryTripcom(query, cabin) {
  const { from, to, date } = query;
  if (isDomestic(from.code, to.code)) return null; // 国内航线不走此接口

  const direct = await bestItinerary([{ segno: 1, ddate: date, dcode: from.code, acode: to.code }], 1, cabin);
  if (!direct) throw new Error('trip.com 直飞无数据');
  const directBest = {
    ...direct.legs[0],
    price: direct.price,
    date,
  };

  const deals = [];
  const seen = new Set();
  const limit = Number(process.env.TRIPCOM_TAILS_LIMIT) || 3;
  const tailCodes = [...continuationsFor(to.code), ...internationalTailsFor(to.code)];
  const uniqueTails = [];
  const tailSeen = new Set();
  for (const tc of tailCodes) {
    const tail = getCity(tc);
    if (!tail) continue;
    if (tailSeen.has(tail.city) || tail.city === from.city || tail.city === to.city) continue;
    tailSeen.add(tail.city);
    uniqueTails.push(tail);
    if (uniqueTails.length >= limit) break;
  }
  const deadline = Date.now() + 65000;
  const rt = await bestRoundTrip(from, to, date, cabin);
  const tailResults = await mapLimit(uniqueTails, 3, async (tail) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    try {
      const through = await bestItinerary([
        { segno: 1, ddate: date, dcode: from.code, acode: to.code },
        { segno: 2, ddate: date, dcode: to.code, acode: tail.code },
      ], 2, cabin, Math.min(15000, remaining));
      if (!through) return null;
      const key = `${through.legs[0].flightNo}-${through.legs[1].flightNo}`;
      return { through, key };
    } catch { return null; }
  });
  for (const item of tailResults) {
    if (!item) continue;
    const { through, key } = item;
    if (seen.has(key)) continue;
    seen.add(key);
    const price = through.price;
    const save = directBest.price - price;
    if (save < 30) continue;
    deals.push({
      id: key,
      rank: 0,
      dealType: 'hidden',
      source: 'tripcom',
      totalPrice: price,
      directPrice: directBest.price,
      saveAmount: save,
      savePercent: Math.round((save / directBest.price) * 1000) / 10,
      layoverMin: through.layoverMin,
      timingUnknown: through.layoverMin === null,
      legs: through.legs,
      skip: `${through.legs[1].to.code} ${through.legs[1].to.city}`,
      skipCity: through.legs[1].to.city,
      tip: `买 ${from.city}→${to.city}→${through.legs[1].to.city} 全程票，只在 ${to.city} 下机，不坐后续 ${through.legs[1].to.city} 段`,
    });
  }
  // 往返甩返程：国际航线往返常比单程便宜（买往返，只用去程）
  if (rt) {
    const save = directBest.price - rt.price;
    if (save >= 30) {
      deals.unshift({
        id: `rt-${from.code}-${to.code}-${rt.returnDate}`,
        rank: 0,
        dealType: 'roundtrip',
        source: 'tripcom',
        totalPrice: rt.price,
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
    emptyReason: deals.length ? null : '实时数据中未发现划算的甩尾方案（甩尾机会通常出现在枢纽城市）。',
  };
}

async function bestRoundTrip(from, to, date, cabin) {
  let best = null;
  const deltas = [7, 14];
  const results = await mapLimit(deltas, 3, async (delta) => {
    const returnDate = addDays(date, delta);
    try {
      const g = await bestItinerary([
        { segno: 1, ddate: date, dcode: from.code, acode: to.code },
        { segno: 2, ddate: returnDate, dcode: to.code, acode: from.code },
      ], 2, cabin);
      if (!g) return null;
      return { returnDate, price: g.price, legs: g.legs };
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
  const g = await bestItinerary([
    { segno: 1, ddate: date, dcode: from.code, acode: to.code },
    { segno: 2, ddate: date, dcode: to.code, acode: tailCode },
  ], 2, cabin);
  if (!g) return null;
  return { tail: getCity(tailCode), price: g.price, legs: g.legs, layoverMin: g.layoverMin };
}

function timeDiff(a, b) {
  if (!a || !b) return null;
  // 中转地的到达与出发共用当地时间，以日历日期保留跨夜等待。
  const arr = Date.parse(a.replace(' ', 'T') + 'Z');
  const dep = Date.parse(b.replace(' ', 'T') + 'Z');
  return Number.isFinite(arr) && Number.isFinite(dep) ? Math.floor((dep - arr) / 60000) : null;
}

async function trySkyscanner() {
  return null; // 需要 SKYSCANNER_API_KEY，未配置时跳过
}

module.exports = { tryTripcom, trySkyscanner, flightSearch, tripcomMixed };
