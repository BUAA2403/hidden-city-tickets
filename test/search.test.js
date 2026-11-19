'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { lyCalendar, tryLycom } = require('../lib/lycom-live');
const { getCity } = require('../lib/cities');
const ctrip = require('../lib/ctrip-browser');

const date = '2030-12-02';

const response = (body) => new Response(JSON.stringify(body));

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

function tripFlight(from, to, no, departure = date) {
  return {
    binfo: { flightno: no, duration: 120 },
    dportinfo: { city: from, aport: from, cname: from },
    aportinfo: { city: to, aport: to, cname: to },
    dateinfo: { dtime: departure + ' 08:00:00', atime: departure + ' 10:00:00' },
  };
}

function tripOffer(flights, price, flightNos = flights.map((f) => f.binfo.flightno)) {
  return {
    flightlist: flights,
    policylist: [{ price: { price }, fgptoken: [...flightNos, price].join('&') }],
  };
}

test('同程请求只采用对应出发日期的报价', async (t) => {
  mockFetch(t, async () => response({ body: { fzpriceinfos: [{ flydate: '2030-12-03', price: 99 }] } }));
  assert.equal(await lyCalendar('CAN', 'PEK', date, [1]), null);
});

test('同程一次查询续程日期范围并优先展示当天方案', async (t) => {
  const oldLimit = process.env.LYCOM_TAILS_LIMIT;
  process.env.LYCOM_TAILS_LIMIT = '2';
  t.after(() => {
    if (oldLimit === undefined) delete process.env.LYCOM_TAILS_LIMIT;
    else process.env.LYCOM_TAILS_LIMIT = oldLimit;
  });
  const requests = [];
  mockFetch(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.EndPort === 'HRB') return new Response(null, { status: 503 });
    const entries = body.travelTypes ? [
      { flydate: '2030-12-10', price: 900, flightno: 'CA1001' },
    ] : [
      { flydate: '2030-12-11', price: 350, transit: 'PEK', flightTrainType: 0, flightno: 'CA1001,CA1002' },
      { flydate: '2030-12-10', price: 500, transit: 'PEK', flightTrainType: 0, flightno: 'CA1001,CA1002' },
      { flydate: '2030-12-09', price: 100, transit: 'PKX', flightTrainType: 0, flightno: 'CZ1001,CZ1002' },
      { flydate: '2030-12-13', price: 100, transit: 'PEK', flightTrainType: 0, flightno: 'CA1001,CA1002' },
    ];
    return response({ body: { fzpriceinfos: entries } });
  });
  const result = await tryLycom({ from: getCity('CAN'), to: getCity('PEK'), date: '2030-12-10' });
  assert.deepEqual(requests.map(({ EndPort, QueryBegDate, QueryEndDate }) => [
    EndPort, QueryBegDate, QueryEndDate,
  ]), [
    ['PEK', '2030-12-10', '2030-12-10'],
    ['CGQ', '2030-12-08', '2030-12-12'],
    ['HRB', '2030-12-08', '2030-12-12'],
  ]);
  assert.deepEqual(result.deals.map(({ shiftDate, saveAmount }) => [shiftDate, saveAmount]), [
    [null, 400], ['2030-12-11', 550],
  ]);
  assert.equal(result.partialSearch, true);
  assert.equal(result.direct.cityLevel, true);
});

test('携程直接读取已渲染的报价卡，无需页面出现订票字样', async () => {
  const browser = Object.create(ctrip.CtripBrowser.prototype);
  browser.send = async () => ({ result: {} });
  browser.evalJs = async (expression) => {
    assert.match(expression, /depdate.+2030-12-10/);
    return { empty: false, texts: ['国航\n09:00\n11:45\nCA1234\n¥450起'] };
  };
  const cards = await browser.navigate('https://flights.ctrip.com/online/list/oneway-CAN-PEK?depdate=2030-12-10');
  assert.deepEqual(cards.map((card) => [card.flightNo, card.price]), [['CA1234', 450]]);
});

test('Trip.com 从所有匹配航段的报价中选最低直飞价', async (t) => {
  const valid = tripOffer([tripFlight('SIN', 'HKG', 'TR982')], 800);
  valid.policylist.push({ price: { price: 20 }, fgptoken: 'XX000&20' });
  mockFetch(t, async (_url, options) => {
    const { triptype } = JSON.parse(options.body).flightcriteria;
    const groups = triptype === 1 ? [
      tripOffer([tripFlight('SIN', 'DAD', 'VJ970'), tripFlight('DAD', 'HKG', 'UO559')], 100),
      tripOffer([tripFlight('SIN', 'HKG', 'SQ874')], 1200),
      tripOffer([tripFlight('SIN', 'HKG', 'XX300', '2030-12-03')], 30),
      valid,
    ] : [];
    return response({ sr: { errcode: 200 }, grouplist: groups });
  });
  const { search } = require('../lib/engine');
  const result = await search({ from: 'SIN', to: 'HKG', date, cabin: 'business' });
  assert.equal(result.direct.best.flightNo, 'TR982');
  assert.equal(result.direct.best.price, 800);
  assert.deepEqual(result.deals, []);
});

test('Trip.com 丢弃多余航段并按有效联程计算节省金额', async (t) => {
  const first = tripFlight('SIN', 'HKG', 'SQ874', '2030-12-04');
  const second = tripFlight('HKG', 'TPE', 'HX241', '2030-12-04');
  second.dateinfo = { dtime: '2030-12-04 12:30:00', atime: '2030-12-04 14:30:00' };
  mockFetch(t, async (_url, options) => {
    const { triptype, seglist } = JSON.parse(options.body).flightcriteria;
    const groups = triptype === 1 ? [tripOffer([first], 1000)] : seglist[1].acode === 'TPE' ? [
      tripOffer([first, second, tripFlight('TPE', 'NRT', 'XK100', '2030-12-04')], 150),
      tripOffer([first, second], 600),
    ] : [];
    return response({ sr: { errcode: 200 }, grouplist: groups });
  });
  const { search } = require('../lib/engine');
  const result = await search({ from: 'SIN', to: 'HKG', date: '2030-12-04' });
  assert.equal(result.deals.length, 1);
  assert.equal(result.deals[0].totalPrice, 600);
  assert.equal(result.deals[0].saveAmount, 400);
  assert.equal(result.deals[0].layoverMin, 150);
  assert.match(result.deals[0].booking.through.ctrip, /tickets-sin-tpe/);
});

test('Trip.com 用实际机场区分上海虹桥和浦东', async (t) => {
  const date = '2030-12-12';
  const wrongAirport = tripFlight('SIN', 'SHA', 'SQ334', date);
  wrongAirport.aportinfo.aport = 'PVG';
  mockFetch(t, async (_url, options) => {
    const { triptype } = JSON.parse(options.body).flightcriteria;
    const groups = triptype === 1 ? [
      tripOffer([wrongAirport], 300),
      tripOffer([tripFlight('SIN', 'SHA', 'MU123', date)], 600),
    ] : [];
    return response({ sr: { errcode: 200 }, grouplist: groups });
  });
  const { search } = require('../lib/engine');
  const result = await search({ from: 'SIN', to: 'SHA', date });
  assert.equal(result.direct.best.flightNo, 'MU123');
  assert.equal(result.direct.best.price, 600);
});

test('Trip.com 直飞查询遇到一次超时后重试', async (t) => {
  const date = '2030-12-14';
  let directCalls = 0;
  mockFetch(t, async (_url, options) => {
    const { triptype } = JSON.parse(options.body).flightcriteria;
    if (triptype !== 1) return response({ sr: { errcode: 200 }, grouplist: [] });
    if (++directCalls === 1) throw new DOMException('请求超时', 'TimeoutError');
    return response({ sr: { errcode: 200 }, grouplist: [
      tripOffer([tripFlight('SIN', 'HKG', 'SQ874', date)], 780),
    ] });
  });
  const { search } = require('../lib/engine');
  const result = await search({ from: 'SIN', to: 'HKG', date });
  assert.equal(result.direct.best.price, 780);
  assert.equal(directCalls, 2);
});

test('携程备用源使用最低直飞价作为基准并剔除更贵的联程', async (t) => {
  const expensive = { price: 1000, arrTime: '12:30', flightNo: 'CA100' };
  const cheap = { price: 400, arrTime: '12:30', flightNo: 'CA200' };
  const fallback = ctrip.searchCtripDomestic;
  const oldEnabled = process.env.CTRIP_BROWSER_ENABLED;
  process.env.CTRIP_BROWSER_ENABLED = '1';
  const enginePath = require.resolve('../lib/engine');
  delete require.cache[enginePath];
  ctrip.searchCtripDomestic = async () => ({
    bestDirect: cheap,
    directCards: [expensive, cheap],
    deals: [
      { tailCode: 'CGQ', card: { ...expensive, price: 600 } },
      { tailCode: 'HRB', card: { ...expensive, price: 350 } },
    ],
  });
  t.after(() => {
    ctrip.searchCtripDomestic = fallback;
    if (oldEnabled === undefined) delete process.env.CTRIP_BROWSER_ENABLED;
    else process.env.CTRIP_BROWSER_ENABLED = oldEnabled;
    delete require.cache[enginePath];
  });
  mockFetch(t, async () => { throw new Error('同程测试故障'); });
  const { search } = require('../lib/engine');
  const result = await search({ from: 'CAN', to: 'PEK', date: '2030-12-05' });
  assert.equal(result.source, 'ctrip-browser');
  assert.equal(result.direct.best.price, 400);
  assert.deepEqual(result.deals.map((deal) => [deal.totalPrice, deal.saveAmount]), [[350, 50]]);
});

test('HTTP 首页、城市、状态接口和无效搜索请求', async (t) => {
  const reservation = createServer().listen(0);
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));

  const child = spawn(process.execPath, ['-e', "globalThis.fetch = async () => { throw Error('测试数据源故障'); }; require('./server.js');"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), CTRIP_BROWSER_ENABLED: '0' },
  });
  t.after(() => child.kill());
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`启动失败，退出码 ${code}`); }),
  ]);

  const base = `http://127.0.0.1:${port}`;
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /searchForm/);
  const cities = await (await fetch(base + '/api/cities')).json();
  assert.ok(cities.cities.some((city) => city.code === 'CAN'));
  const status = await (await fetch(base + '/api/status')).json();
  assert.equal(status.app, 'hidden-city-tickets');
  assert.equal(status.config.port, port);

  const post = (body) => fetch(base + '/api/search', { method: 'POST', body });
  for (const input of ['null', '[1]', '{', '{"from":"CAN","to":"PEK","date":"2026-02-30"}']) {
    const failure = await post(input);
    assert.equal(failure.status, 400);
    assert.ok((await failure.json()).error);
  }
  const oversized = await post('x'.repeat(65537));
  assert.equal(oversized.status, 413);
  assert.ok((await oversized.json()).error);
  const unavailable = await post('{"from":"SIN","to":"HKG","date":"2030-12-10","cabin":"business"}');
  assert.equal(unavailable.status, 503);
  const fallback = await unavailable.json();
  assert.match(fallback.error, /直飞报价/);
  assert.match(fallback.bookingLinks[0].url, /tickets-sin-hkg.*ddate=2030-12-10.*classType=BFGroup/);
  const domestic = await post('{"from":"URC","to":"PKX","date":"2030-12-10"}');
  assert.equal(domestic.status, 503);
  assert.match((await domestic.json()).bookingLinks[0].url, /URC-PKX\?date=2030-12-10/);
});
