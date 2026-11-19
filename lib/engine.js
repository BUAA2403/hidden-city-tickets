'use strict';

const { getCity, isDomestic, candidateTails } = require('./cities');
const { mapLimit } = require('./search-workers');
const { tryTripcom, tripcomMixed } = require('./live');
const { searchCtripDomestic } = require('./ctrip-browser');
const { tryLycom } = require('./lycom-live');

function defaultDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function validateQuery(q) {
  const from = getCity(q.from);
  const to = getCity(q.to);
  if (!from || !to) return { error: '出发地或目的地不在支持列表中，请从候选中选择。' };
  if (from.code === to.code) return { error: '出发地和目的地不能相同。' };
  if (from.city === to.city) return { error: '出发地和目的地是同一城市，请选择不同城市。' };
  if (q.date && !validDate(q.date)) return { error: '出发日期无效，请重新选择。' };
  const date = q.date || defaultDate();
  return { from, to, date };
}

function ctripUrl(fromCode, toCode, dateStr) {
  const dom = isDomestic(fromCode, toCode);
  if (dom) return `https://flights.ctrip.com/online/list/oneway-${fromCode}-${toCode}?depdate=${dateStr}`;
  return `https://flights.ctrip.com/international/search/oneway-${fromCode}-${toCode}?depdate=${dateStr}&cabin=y_s&adult=1`;
}

function skyscannerUrl(fromCode, toCode, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const ddmmyy = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getFullYear()).slice(2)}`;
  return `https://www.skyscanner.net/transport/flights/${fromCode.toLowerCase()}/${toCode.toLowerCase()}/${ddmmyy}/`;
}

// 同程航班列表页：追加 &flightno= 让页面直接展开目标航班的舱位与价格
function lycomUrl(fromCode, toCode, dateStr, flightNo) {
  const base = `https://www.ly.com/flights/itinerary/oneway/${fromCode}-${toCode}?date=${dateStr}`;
  return flightNo ? `${base}&flightno=${encodeURIComponent(flightNo)}` : base;
}

function slug(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Trip.com 机票页按“城市”而非“机场”建页：多机场城市需要映射到城市码和官方英文名
const TRIPCOM_CITY = {
  PEK: { code: 'BJS', slug: 'beijing' }, PKX: { code: 'BJS', slug: 'beijing' },
  SHA: { code: 'SHA', slug: 'shanghai' }, PVG: { code: 'SHA', slug: 'shanghai' },
  CTU: { code: 'CTU', slug: 'chengdu' }, TFU: { code: 'CTU', slug: 'chengdu' },
  HND: { code: 'TYO', slug: 'tokyo' }, NRT: { code: 'TYO', slug: 'tokyo' },
  KIX: { code: 'OSA', slug: 'osaka' },
  ICN: { code: 'SEL', slug: 'seoul' },
  MXP: { code: 'MIL', slug: 'milan' },
  SVO: { code: 'MOW', slug: 'moscow' },
  JFK: { code: 'NYC', slug: 'new-york' }, EWR: { code: 'NYC', slug: 'new-york' },
  IAD: { code: 'WAS', slug: 'washington' },
  LHR: { code: 'LON', slug: 'london' },
  CDG: { code: 'PAR', slug: 'paris' },
  YMQ: { code: 'YUL', slug: 'montreal' },
};

// Trip.com 纯航班列表页（与价格同源、强制人民币显示；不再是“机+酒”捆绑页）
function tripcomUrl(fromCode, toCode, dateStr, returnDate, cabin) {
  const f = TRIPCOM_CITY[fromCode] || { code: fromCode, slug: slug((getCity(fromCode) || {}).en) || fromCode.toLowerCase() };
  const t = TRIPCOM_CITY[toCode] || { code: toCode, slug: slug((getCity(toCode) || {}).en) || toCode.toLowerCase() };
  const base = `https://www.trip.com/flights/${f.slug}-to-${t.slug}/tickets-${f.code.toLowerCase()}-${t.code.toLowerCase()}/?ddate=${dateStr}&curr=CNY&locale=zh-CN`;
  const cabinUrl = cabin === 'business' ? '&classType=BFGroup' : '&classType=Economy';
  if (returnDate) {
    return `${base}${cabinUrl}&rdate=${returnDate}`;
  }
  return base + cabinUrl;
}

function unavailable(query, cabin, details) {
  const { from, to, date } = query;
  const tripcom = { label: '在 Trip.com 查票', url: tripcomUrl(from.code, to.code, date, undefined, cabin) };
  const bookingLinks = isDomestic(from.code, to.code) && cabin === 'economy'
    ? [{ label: '在同程查票', url: lycomUrl(from.code, to.code, date) }, { label: '在携程查票', url: ctripUrl(from.code, to.code, date) }]
    : [tripcom, { label: '在 Skyscanner 查票', url: skyscannerUrl(from.code, to.code, date) }];
  return {
    statusCode: 503,
    error: `暂时无法取得可用于比较的直飞报价（${details}）。你可以按原航线和日期到购票网站查询。`,
    bookingLinks,
  };
}

function decorate(result, cabin) {
  const { from, to, date } = result.query;
  const direct = result.direct;
  const directProvider = { lycom: '同程', tripcom: 'Trip.com', ctrip: '携程' }[direct.source];
  const directPrimary =
    direct.source === 'lycom' ? lycomUrl(from.code, to.code, date, direct.best && direct.best.flightNo) :
    direct.source === 'tripcom' ? tripcomUrl(from.code, to.code, date, undefined, cabin) :
    ctripUrl(from.code, to.code, date);
  if (direct.best) {
    direct.best = { ...direct.best, booking: { ctrip: directPrimary, skyscanner: skyscannerUrl(from.code, to.code, date) } };
  }
  direct.options = (direct.options || []).map((o) => ({ ...o, booking: { ctrip: directPrimary, skyscanner: skyscannerUrl(from.code, to.code, date) } }));
  result.deals = (result.deals || []).map((d) => {
    const tail = d.legs && d.legs[1] && d.legs[1].to ? d.legs[1].to.code : '';
    let through;
    if (d.dealType === 'roundtrip' && d.returnDate) {
      const rtUrl = d.source === 'tripcom'
        ? tripcomUrl(from.code, to.code, date, d.returnDate, cabin)
        : `https://flights.ctrip.com/itinerary/roundtrip/${from.code}-${to.code}?date=${date},${d.returnDate}`;
      through = { ctrip: rtUrl, skyscanner: '', provider: d.source === 'tripcom' ? 'Trip.com' : '携程', note: '请核对去程、返程日期和航班号。' };
    } else if (d.source === 'tripcom') {
      through = {
        ctrip: tail ? tripcomUrl(from.code, tail, date, undefined, cabin) : '',
        skyscanner: tail ? skyscannerUrl(from.code, tail, date) : '',
        provider: 'Trip.com',
        note: '参考价来自两段航班查询。核价时请在当日单程列表按中转城市和航班号查找。',
      };
    } else {
      through = {
        ctrip: tail ? ctripUrl(from.code, tail, date) : '',
        skyscanner: tail ? skyscannerUrl(from.code, tail, date) : '',
        provider: '携程',
        note: d.source === 'lycom'
          ? '同程参考价与携程报价可能不同。请开启「中转」，按两段航班号核对。'
          : '请开启「中转」，按中转城市和航班号核对。',
      };
    }
    return {
      ...d,
      booking: {
        through,
        direct: { ctrip: directPrimary, skyscanner: skyscannerUrl(from.code, to.code, date), provider: directProvider },
      },
    };
  });
  return result;
}

function transferMinutes(card) {
  return (card && card.layoverMin) || 0;
}

function normalizeCtrip(query, res) {
  const { from, to, date } = query;
  const directOptions = (res.directCards || [])
    .filter((c) => !c.transfer && !c.stopover)
    .sort((a, b) => a.price - b.price)
    .slice(0, 8)
    .map((c) => ({
      airline: c.airline,
      airlineName: c.airline,
      flightNo: c.flightNo || '',
      from: { code: from.code, city: from.city, airport: from.airport },
      to: { code: to.code, city: to.city, airport: to.airport },
      depTime: c.depTime,
      arrTime: c.arrTime + (c.arrNextDay ? ' (+1)' : ''),
      durationMin: 0,
      price: c.price,
      fetchedAt: c.fetchedAt,
      date,
    }));
  const bestDirect = directOptions[0] || null;
  const deals = (res.deals || []).map((d, i) => {
    const c = d.card;
    const tail = getCity(d.tailCode);
    if (!bestDirect) return null;
    const save = bestDirect.price - c.price;
    if (save <= 0) return null;
    return {
      id: `${from.code}-${to.code}-${d.tailCode}-${i}`,
      rank: i + 1,
      totalPrice: c.price,
      fetchedAt: c.fetchedAt,
      source: 'ctrip',
      directPrice: bestDirect.price,
      saveAmount: save,
      savePercent: Math.round((save / bestDirect.price) * 1000) / 10,
      layoverMin: transferMinutes(c),
      timingUnknown: true,
      legs: [
        { airline: c.airline, airlineName: c.airline, flightNo: c.flightNo || '', from: { code: from.code, city: from.city, airport: from.airport }, to: { code: to.code, city: to.city, airport: to.airport }, depTime: c.depTime, arrTime: '—', durationMin: 0, date },
        { airline: '', airlineName: '', flightNo: '', from: { code: to.code, city: to.city, airport: to.airport }, to: { code: tail.code, city: tail.city, airport: tail.airport }, depTime: '—', arrTime: c.arrTime + (c.arrNextDay ? ' (+1)' : ''), durationMin: 0 },
      ],
      skip: `${tail.code} ${tail.city}${tail.airport}`,
      skipCity: tail.city,
      tip: `买 ${from.city}→${to.city}→${tail.city} 全程票，只在 ${to.city} 下机，不坐后续 ${tail.city} 段`,
    };
  }).filter(Boolean).sort((a, b) => b.saveAmount - a.saveAmount);
  deals.forEach((d, i) => (d.rank = i + 1));
  return {
    query: { from: { code: from.code, city: from.city, airport: from.airport }, to: { code: to.code, city: to.city, airport: to.airport }, date },
    direct: { best: bestDirect, options: directOptions, source: 'ctrip' },
    deals: deals.slice(0, 8),
    emptyReason: deals.length ? null : '实时数据中未发现划算的甩尾方案（甩尾机会通常出现在枢纽城市）。',
  };
}

function withTimeout(ms, promise) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('超时')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function search(rawQuery) {
  const v = validateQuery(rawQuery);
  if (v.error) return { error: v.error };
  const query = { from: v.from, to: v.to, date: v.date };
  const cabin = rawQuery.cabin === 'business' ? 'business' : 'economy';

  if (isDomestic(v.from.code, v.to.code)) {
    // 国内数据源（同程价格日历）只提供经济舱实时价
    if (cabin === 'business') {
      return { error: '国内航线（同程数据源）暂只支持经济舱实时价；公务/头等舱请到购票网站（携程/同程）按舱位查询。' };
    }
    // 1) 同程（首选，纯 HTTP 实时）
    try {
      const res = await withTimeout(90000, tryLycom(query));
      if (res && res.direct && res.direct.best) {
        // 国内飞国内甩国际段：用 Trip.com 混合联程查询国际尾巴
        const directPrice = res.direct.best.price;
        const mixedLimit = Number(process.env.MIXED_TAILS_LIMIT) || 10;
        const mixedCandidates = candidateTails(v.from, v.to, 'international', mixedLimit);
        const mixedResults = await mapLimit(mixedCandidates, 3, async (tail) => {
          try {
            const m = await tripcomMixed(query, tail.code, cabin);
            return m ? { m, tail } : null;
          } catch { return null; }
        }, Date.now() + 35000);
        for (const item of mixedResults) {
          if (!item) continue;
          const { m, tail } = item;
          if (m.price >= directPrice) continue;
          const save = directPrice - m.price;
          res.deals.push({
            id: `mix-${v.from.code}-${v.to.code}-${tail.code}`,
            rank: 0,
            dealType: 'intl',
            source: 'tripcom',
            totalPrice: m.price,
            fetchedAt: m.fetchedAt,
            directPrice,
            saveAmount: save,
            savePercent: Math.round((save / directPrice) * 1000) / 10,
            layoverMin: m.layoverMin,
            timingUnknown: m.layoverMin == null,
            legs: m.legs,
            skip: `${tail.code} ${tail.city}${tail.airport}`,
            skipCity: tail.city,
            tip: `买 ${v.from.city}→${v.to.city}→${tail.city} 国际联程票，只在 ${v.to.city} 下机，甩掉国际段（Trip.com 实时价）。`,
          });
        }
        res.deals.sort((a, b) => b.saveAmount - a.saveAmount);
        res.deals.forEach((d, i) => (d.rank = i + 1));
        return {
          ...decorate(res, cabin),
          mode: 'live',
          source: res.deals.some((d) => d.dealType === 'intl') ? 'lycom+tripcom' : 'lycom',
          sourceLabel: res.deals.some((d) => d.dealType === 'intl') ? '实时 · 同程 + Trip.com' : '实时 · 同程',
          sourceNote: '报价可能随渠道、舱位和余票变化，请以购票网站结算页的总价为准。',
        };
      }
      throw new Error(`${query.date} 直飞无可核对报价`);
    } catch (e1) {
      if (process.env.CTRIP_BROWSER_ENABLED !== '1') return unavailable(query, cabin, e1.message);
      // 显式启用浏览器备用源时继续查询。
      try {
        const res = await withTimeout(50000, searchCtripDomestic(query, AbortSignal.timeout(45000)));
        if (!res || !res.bestDirect) throw new Error(`${query.date} 直飞无可核对报价`);
        const norm = normalizeCtrip(query, res);
        return {
          ...decorate(norm, cabin),
          mode: 'live',
          source: 'ctrip-browser',
          sourceLabel: '实时 · 携程（浏览器会话）',
          sourceNote: '报价可能随舱位和余票变化，请以携程结算页的总价为准。',
        };
      } catch (e2) {
        return unavailable(query, cabin, [e1.message, e2.message].join(" / "));
      }
    }
  } else {
    try {
      const liveResult = await withTimeout(120000, tryTripcom(query, cabin));
      if (!liveResult) throw new Error('trip.com 不支持该航线');
      const cabinLabel = cabin === 'business' ? '公务舱' : '经济舱';
      return { ...decorate(liveResult, cabin), mode: 'live', source: 'tripcom', sourceLabel: `Trip.com · ${cabinLabel}`, sourceNote: '报价可能随舱位和余票变化，请以 Trip.com 结算页的总价为准。' };
    } catch (e) {
      return unavailable(query, cabin, e.message);
    }
  }
}

module.exports = { search };
