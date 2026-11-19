'use strict';

// 同程旅行（ly.com）国内航线实时数据：无签名、稳定、返回真实航班与价格。
// 直飞价：getpricecalendar + travelTypes:[1]；联程价：默认返回全网最低（含中转城市码）。

const { mapLimit } = require('./search-workers');
const { CITIES, candidateTails, getCity, airlineName } = require('./cities');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CAL_URL = 'https://www.ly.com/flights/api/query/getpricecalendar';

const CITY_TRANSIT_ALIASES = {
  北京: ['PEK', 'PKX', 'NAY', 'BJS'],
  上海: ['SHA', 'PVG'],
  成都: ['CTU', 'TFU'],
  东京: ['NRT', 'HND', 'TYO'],
  首尔: ['ICN', 'SEL'],
  大阪: ['KIX', 'OSA'],
  广州: ['CAN'],
  深圳: ['SZX'],
  香港: ['HKG'],
  台北: ['TPE'],
  长春: ['CGQ'],
  沈阳: ['SHE'],
  哈尔滨: ['HRB'],
  大连: ['DLC'],
  青岛: ['TAO'],
  杭州: ['HGH'],
  厦门: ['XMN'],
  南京: ['NKG'],
  武汉: ['WUH'],
  西安: ['XIY'],
  昆明: ['KMG'],
  重庆: ['CKG'],
  长沙: ['CSX'],
  天津: ['TSN'],
  郑州: ['CGO'],
  三亚: ['SYX'],
  海口: ['HAK'],
  乌鲁木齐: ['URC'],
  兰州: ['LHW'],
  贵阳: ['KWE'],
  南宁: ['NNG'],
  济南: ['TNA'],
  烟台: ['YNT'],
  威海: ['WEH'],
  无锡: ['WUX'],
  宁波: ['NGB'],
  温州: ['WNZ'],
  福州: ['FOC'],
  太原: ['TYN'],
  石家庄: ['SJW'],
  呼和浩特: ['HET'],
};

function transitAliases(city) {
  return CITY_TRANSIT_ALIASES[city] || [city];
}

function cacheKey(from, to, date, types) {
  return `${from}-${to}-${date}-${types || ''}`;
}

const cache = new Map();
// 价格日历会随余票/活动实时变化，缓存设短一些，避免“推荐价”与点击时看到的价差过大
const cacheTtlMs = Number(process.env.LYCOM_CACHE_TTL_MS) || 30 * 60 * 1000;

// 单字母航司码 + 4~5 位数字通常是火车车次（D/G/C/K/T/Z 等动车高铁），
// 同程会把“空铁联运”也放进价格日历，必须过滤掉，不能当航班展示
function isTrainNo(no) {
  return /^[CDFGJKTZ]\d{4,5}$/i.test(String(no || '').trim());
}

// 价格日历中的“中转方案”必须是真实的两段航班（flightno 恰好两个航班号），
// 单航班表示经停（不是换机中转），空铁联运或异常数据直接跳过
function isRealTransferEntry(entry) {
  if (!entry || Number(entry.flightTrainType) !== 0) return false;
  const nos = String(entry.flightno || '').split(',').filter(Boolean);
  if (nos.length !== 2) return false;
  if (nos.some((n) => isTrainNo(n))) return false;
  return true;
}

async function calendarEntries(fromCode, toCode, date, travelTypes) {
  const key = cacheKey(fromCode, toCode, date, travelTypes && travelTypes.join(','));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < cacheTtlMs) return hit.entries;
  const body = {
    StartPort: fromCode,
    EndPort: toCode,
    QueryBegDate: date,
    QueryEndDate: date,
    QueryType: 1,
    IsFromPhoenix: 1,
  };
  if (travelTypes) body.travelTypes = travelTypes;
  const res = await fetch(CAL_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(9000),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.ly.com',
      Referer: 'https://www.ly.com/flights/home',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`同程接口 HTTP ${res.status}`);
  const j = await res.json();
  const list = (j.body && j.body.fzpriceinfos) || [];
  const matches = list.filter((x) => {
    if (!x || x.flydate !== date || !Number.isFinite(Number(x.price)) || Number(x.price) <= 0) return false;
    const departureDate = /^\d{4}-\d{2}-\d{2}/.exec(x.flytime || '');
    return !departureDate || departureDate[0] === date;
  });
  const ts = Date.now();
  const fetchedAt = new Date(ts).toISOString();
  const entries = matches.sort((a, b) => a.price - b.price).map((x) => ({ ...x, fetchedAt }));
  cache.set(key, { ts, entries });
  return entries;
}

async function lyCalendar(fromCode, toCode, date, travelTypes) {
  const entries = await calendarEntries(fromCode, toCode, date, travelTypes);
  return entries[0] || null;
}

function hm(dt) {
  return (dt || '').slice(11, 16) || (dt || '').slice(0, 5);
}

function isNextDay(fly, arr) {
  const d1 = (fly || '').slice(0, 10);
  const d2 = (arr || '').slice(0, 10);
  return d1 && d2 && d1 !== d2;
}

function airlineFrom(flightNo) {
  const m = /^([A-Z0-9]+?)(\d+)$/.exec(flightNo || '');
  return m ? m[1] : '';
}

function transitMatches(code, toCity) {
  if (!code) return false;
  return getCity(code)?.city === toCity || transitAliases(toCity).includes(code.toUpperCase());
}

function buildEntryDeal(entry, query, tail) {
  const { from, to, date } = query;
  const nos = String(entry.flightno || '').split(',').filter(Boolean);
  if (nos.length < 2) return null;
  if (nos.some((n) => isTrainNo(n))) return null;
  const leg1 = {
    airline: airlineFrom(nos[0]),
    airlineName: airlineName(airlineFrom(nos[0])) || airlineFrom(nos[0]),
    flightNo: nos[0] || '',
    from: { code: from.code, city: from.city, airport: from.airport },
    to: { code: to.code, city: to.city, airport: to.airport },
    depTime: hm(entry.flytime),
    arrTime: '—',
    durationMin: 0,
    date,
  };
  const leg2 = {
    airline: airlineFrom(nos[1]),
    airlineName: airlineName(airlineFrom(nos[1])) || airlineFrom(nos[1]),
    flightNo: nos[1] || '',
    from: { code: to.code, city: to.city, airport: to.airport },
    to: { code: tail.code, city: tail.city, airport: tail.airport },
    depTime: '—',
    arrTime: hm(entry.arrtime) + (isNextDay(entry.flytime, entry.arrtime) ? ' (+1)' : ''),
    durationMin: 0,
  };
  return {
    id: `${from.code}-${to.code}-${tail.code}-${date}-${nos.join('')}`,
    dealType: 'hidden',
    source: 'lycom',
    totalPrice: Number(entry.price),
    fetchedAt: entry.fetchedAt,
    directPrice: null,
    saveAmount: 0,
    savePercent: 0,
    layoverMin: null,
    timingUnknown: true, // 价格日历不提供第二段起飞/中转时长，避免展示编造的时长
    legs: [leg1, leg2],
    skip: `${tail.code} ${tail.city}${tail.airport}`,
    skipCity: tail.city,
    tip: `买 ${from.city}→${to.city}→${tail.city} 全程票，只在 ${to.city} 下机，不坐后续 ${tail.city} 段`,
  };
}

async function tryLycom(query) {
  const { from, to, date } = query;
  const directEntry = await lyCalendar(from.code, to.code, date, [1]);
  const directPrice = Number(directEntry?.price);
  if (!Number.isFinite(directPrice) || directPrice <= 0) return null;
  const nos = String(directEntry.flightno || '').split(',').filter(Boolean);
  const directBest = {
    airline: airlineFrom(nos[0]),
    airlineName: airlineName(airlineFrom(nos[0])) || airlineFrom(nos[0]),
    flightNo: nos[0] || '',
    from: { code: from.code, city: from.city, airport: from.airport },
    to: { code: to.code, city: to.city, airport: to.airport },
    depTime: hm(directEntry.flytime),
    arrTime: hm(directEntry.arrtime) + (isNextDay(directEntry.flytime, directEntry.arrtime) ? ' (+1)' : ''),
    durationMin: 0,
    price: directPrice,
    fetchedAt: directEntry.fetchedAt,
    date,
  };

  const deals = [];
  const limit = Number(process.env.LYCOM_TAILS_LIMIT) || 32;
  const tails = candidateTails(from, to, 'domestic', limit);
  let checked = 0;
  let matched = 0;
  let failed = 0;
  await mapLimit(tails, 4, async (tail) => {
    checked++;
    try {
      const entries = await calendarEntries(from.code, tail.code, date);
      const entry = entries.find((x) => isRealTransferEntry(x) && String(x.transit).toUpperCase() === to.code);
      if (!entry) return;
      matched++;
      const price = Number(entry.price);
      const deal = buildEntryDeal(entry, query, tail);
      if (!deal) return;
      deal.directPrice = directPrice;
      deal.saveAmount = directPrice - price;
      deal.savePercent = Math.round((deal.saveAmount / directPrice) * 1000) / 10;
      if (deal.saveAmount <= 0) return;
      deals.push(deal);
    } catch { failed++; }
  }, Date.now() + 62000);

  deals.sort((a, b) => b.saveAmount - a.saveAmount);
  deals.forEach((d, i) => (d.rank = i + 1));

  return {
    query: {
      from: { code: from.code, city: from.city, airport: from.airport },
      to: { code: to.code, city: to.city, airport: to.airport },
      date,
    },
    direct: { best: directBest, options: [directBest], source: 'lycom', cityLevel: CITIES.some(c => (c.city === from.city && c.code !== from.code) || (c.city === to.city && c.code !== to.code)) },
    partialSearch: failed > 0 || checked < tails.length,
    deals: deals.slice(0, 8),
    emptyReason: deals.length ? null : `同程已查到 ${checked - failed} 个候选城市的查询结果，其中 ${matched} 个有经${to.city}换机的报价。当日可比报价中未找到低于直飞的方案。${failed ? `另有 ${failed} 个城市查询失败。` : ''}`,
  };
}

module.exports = { tryLycom, lyCalendar, transitMatches };
