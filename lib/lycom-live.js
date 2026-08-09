'use strict';

// 同程旅行（ly.com）国内航线实时数据：无签名、稳定、返回真实航班与价格。
// 直飞价：getpricecalendar + travelTypes:[1]；联程价：默认返回全网最低（含中转城市码）。

const { continuationsFor, getCity, airlineName } = require('./cities');

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

async function lyCalendar(fromCode, toCode, date, travelTypes) {
  const key = cacheKey(fromCode, toCode, date, travelTypes && travelTypes.join(','));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < cacheTtlMs) return hit.entry;
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
  const entry = list.find((x) => x && x.flydate === date) || list[0] || null;
  cache.set(key, { ts: Date.now(), entry });
  return entry;
}

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
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
  return transitAliases(toCity).includes(code.toUpperCase());
}

function buildEntryDeal(entry, query, tail, shiftedDate) {
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
    date: shiftedDate || date,
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
    date: shiftedDate || date,
  };
  return {
    id: `${from.code}-${to.code}-${tail.code}-${shiftedDate || date}-${nos.join('')}`,
    dealType: 'hidden',
    source: 'lycom',
    totalPrice: entry.price,
    directPrice: null,
    saveAmount: 0,
    savePercent: 0,
    layoverMin: null,
    timingUnknown: true, // 价格日历不提供第二段起飞/中转时长，避免展示编造的时长
    legs: [leg1, leg2],
    skip: `${tail.code} ${tail.city}${tail.airport}`,
    skipCity: tail.city,
    shiftDate: shiftedDate || null,
    tip: `买 ${from.city}→${to.city}→${tail.city} 全程票，只在 ${to.city} 下机，不坐后续 ${tail.city} 段`,
  };
}

async function tryLycom(query) {
  const { from, to, date } = query;
  const directEntry = await lyCalendar(from.code, to.code, date, [1]);
  if (!directEntry || !directEntry.price) return null;
  const directPrice = directEntry.price;
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
    date,
  };

  const deals = [];
  const seen = new Set();
  const usedCities = new Set();
  const limit = Number(process.env.LYCOM_TAILS_LIMIT) || 4;
  let checked = 0;
  const tailCodes = continuationsFor(to.code);

  for (const tc of tailCodes) {
    const tail = getCity(tc);
    if (!tail) continue;
    if (usedCities.has(tail.city) || tail.city === from.city || tail.city === to.city) continue;
    usedCities.add(tail.city);
    if (checked >= limit) break;
    checked++;

    // 目标日期 + 前后 2 天扫描“经 D 中转”的联程
    const dates = [0, 1, -1, 2, -2];
    for (const delta of dates) {
      const d = delta === 0 ? date : addDays(date, delta);
      try {
        const entry = await lyCalendar(from.code, tail.code, d);
        if (!entry || !entry.price || !transitMatches(entry.transit, to.city)) continue;
        if (!isRealTransferEntry(entry)) continue;
        const shifted = delta === 0 ? null : d;
        const deal = buildEntryDeal(entry, query, tail, shifted);
        if (!deal) continue;
        deal.directPrice = directPrice;
        deal.saveAmount = directPrice - entry.price;
        deal.savePercent = Math.round((deal.saveAmount / directPrice) * 1000) / 10;
        if (deal.saveAmount < 30 || deal.savePercent < 3) continue;
        const key = `${tail.code}-${d}-${entry.flightno}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deals.push(deal);
      } catch { /* 单日查询失败跳过 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  deals.sort((a, b) => (b.shiftDate ? 0 : 1) - (a.shiftDate ? 0 : 1) || b.saveAmount - a.saveAmount);
  deals.forEach((d, i) => (d.rank = i + 1));

  return {
    query: {
      from: { code: from.code, city: from.city, airport: from.airport },
      to: { code: to.code, city: to.city, airport: to.airport },
      date,
    },
    direct: { best: directBest, options: [directBest], source: 'lycom' },
    deals: deals.slice(0, 8),
    emptyReason: deals.length ? null : '实时数据中未发现划算的甩尾方案（甩尾机会通常出现在枢纽城市）。',
  };
}

module.exports = { tryLycom, lyCalendar, transitMatches };
