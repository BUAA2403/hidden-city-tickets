(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const fromInput = $('#fromInput');
  const toInput = $('#toInput');
  const dateInput = $('#dateInput');
  const cabinSelect = $('#cabinSelect');
  const searchBtn = $('#searchBtn');
  const form = $('#searchForm');
  const results = $('#results');
  const loading = $('#loading');
  const summaryBox = $('#summary');
  const sourceNote = $('#sourceNote');
  const dealList = $('#dealList');
  const emptyState = $('#emptyState');
  const directPanel = $('#directPanel');
  const statusBadge = $('#statusBadge');
  const statusText = $('#statusText');

  let searchController;
  let cities = [];
  let selected = { from: null, to: null };
  const choosers = {};

  // ---------- 基础工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtMoney(n) {
    return '¥' + Number(n).toLocaleString('zh-CN');
  }

  function fmtDur(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h ? `${h}小时${m ? m + '分' : ''}` : `${m}分钟`;
  }

  function defaultDate() {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const parts = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
    return parts.map((part) => String(part).padStart(2, '0')).join('-');
  }

  const quoteSources = { lycom: '同程', tripcom: 'Trip.com', ctrip: '携程' };

  // ---------- 自动补全 ----------
  function bindSuggest(input, key, otherKey) {
    const wrap = input.closest('.field');
    const box = wrap.querySelector('.suggest');
    let active = -1;
    let current = [];

    function matches(q) {
      const s = q.trim().toLowerCase();
      if (!s) return [];
      const code = s.toUpperCase();
      const byCode = cities.find((c) => c.code === code);
      if (byCode) return [byCode];
      return cities.filter((c) =>
        c.city.includes(s) || c.en.toLowerCase().includes(s) || c.airport.toLowerCase().includes(s)
      ).slice(0, 8);
    }

    function render(list, activeIndex = -1) {
      current = list;
      active = activeIndex;
      if (!list.length) { box.hidden = true; return; }
      box.innerHTML = list.map((c, i) => `
        <div class="suggest-item ${i === active ? 'active' : ''}" data-i="${i}">
          <span>${esc(c.city)} <span class="airport">${esc(c.airport)}</span></span>
          <span class="code">${c.code}</span>
        </div>`).join('');
      box.hidden = false;
    }

    function hide() { box.hidden = true; }

    function choose(c) {
      selected[key] = c;
      input.value = `${c.city} ${c.code}`;
      hide();
      const other = selected[otherKey];
      if (other && other.code === c.code) {
        selected[otherKey] = null;
        if (otherKey === 'from') fromInput.value = '';
        else toInput.value = '';
      }
    }
    choosers[key] = choose;

    input.addEventListener('input', () => {
      selected[key] = null;
      const q = input.value;
      if (/^[A-Za-z]{3}$/.test(q)) {
        const exact = cities.find((c) => c.code === q.toUpperCase());
        if (exact) { selected[key] = exact; }
      }
      render(matches(q));
    });

    input.addEventListener('focus', () => {
      if (input.value.trim()) render(matches(input.value));
    });

    input.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, current.length - 1); render(current, active); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(current, active); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (active >= 0 && current[active]) choose(current[active]);
        else if (current.length === 1) choose(current[0]);
        else if (selected[key]) form.requestSubmit();
      } else if (e.key === 'Escape') hide();
    });

    input.addEventListener('blur', () => setTimeout(hide, 120));
    box.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.suggest-item');
      if (item) choose(current[Number(item.dataset.i)]);
    });

    // 从 URL / 代码直接赋值
    window.__selectCity = (k, code) => {
      const c = cities.find((x) => x.code === code);
      if (c && choosers[k]) choosers[k](c);
    };
  }

  // ---------- URL 参数 ----------
  function readUrlParams() {
    const p = new URLSearchParams(location.search);
    const from = p.get('from');
    const to = p.get('to');
    const date = p.get('date');
    const cabin = p.get('cabin');
    if (from && cities.some((c) => c.code === from)) window.__selectCity('from', from);
    if (to && cities.some((c) => c.code === to)) window.__selectCity('to', to);
    if (date !== null) dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
    if (cabin === 'economy' || cabin === 'business') cabinSelect.value = cabin;
  }

  function writeUrlParams() {
    const p = new URLSearchParams();
    if (selected.from) p.set('from', selected.from.code);
    if (selected.to) p.set('to', selected.to.code);
    if (dateInput.value) p.set('date', dateInput.value);
    p.set('cabin', cabinSelect.value);
    const qs = p.toString();
    history.replaceState(null, '', qs ? '/?' + qs : '/');
  }

  // ---------- 交换 ----------
  $('#swapBtn').addEventListener('click', () => {
    const f = selected.from;
    const t = selected.to;
    const fv = fromInput.value;
    const tv = toInput.value;
    selected.from = t; selected.to = f;
    fromInput.value = tv; toInput.value = fv;
  });

  // ---------- 示例 chips ----------
  $$('#exampleChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      window.__selectCity('from', chip.dataset.from);
      window.__selectCity('to', chip.dataset.to);
      form.requestSubmit();
    });
  });

  // ---------- 搜索 ----------
  async function doSearch() {
    if (!selected.from || !selected.to) {
      if (!selected.from) { fromInput.focus(); return; }
      toInput.focus(); return;
    }
    if (!dateInput.reportValidity()) return;
    const date = dateInput.value;
    writeUrlParams();

    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    loading.hidden = false;
    dealList.innerHTML = '';
    emptyState.hidden = true;
    directPanel.hidden = true;
    summaryBox.hidden = true;
    sourceNote.hidden = true;
    document.querySelector('#loading p').textContent = '正在搜索直飞与联程实时票价。查询时间随航线、候选数量和数据源变化。';
    searchBtn.disabled = true;
    searchBtn.querySelector('.btn-label').textContent = '搜索中…';
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: selected.from.code,
          to: selected.to.code,
          date,
          cabin: cabinSelect.value,
        }),
      });
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (res.status === 503) {
        emptyState.hidden = false;
        const links = (data.bookingLinks || []).map(({ label, url }) =>
          `<a class="btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('');
        emptyState.innerHTML = `<h3>实时报价暂不可用</h3><p>${esc(data.error)}</p><div class="deal-actions">${links}</div>`;
        statusText.textContent = '实时报价暂不可用';
        return;
      }
      if (!res.ok) throw new Error(data.error || '搜索失败');
      renderResults(data);
    } catch (e) {
      if (controller.signal.aborted) return;
      loading.hidden = true;
      emptyState.hidden = false;
      emptyState.innerHTML = `<div class="empty-icon">😥</div><h3>出错了</h3><p>${esc(e.message)}</p>`;
    } finally {
      if (searchController === controller) {
        searchController = null;
        loading.hidden = true;
        searchBtn.disabled = false;
        searchBtn.querySelector('.btn-label').textContent = '搜索甩尾方案';
      }
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });

  // ---------- 渲染 ----------
  function renderResults(data) {
    const q = data.query;
    const direct = data.direct.best;
    const bestDeal = data.deals[0];
    const directSource = quoteSources[data.direct.source];

    // 数据源提示
    sourceNote.hidden = false;
    sourceNote.className = 'source-note live';
    sourceNote.innerHTML = `<span>🟢</span><div><b>${esc(q.date)} 出发 · ${esc(data.sourceLabel || '')}</b> · ${esc([data.sourceNote, data.direct.cityLevel && '直飞参考价可能覆盖同城其他机场。', data.partialSearch && '部分候选未完成核价。'].filter(Boolean).join(' '))}</div>`;
    statusText.textContent = '实时数据已接通';

    // 汇总
    summaryBox.hidden = false;
    summaryBox.innerHTML = `
      <div class="summary-card">
        <div class="label">✈️ ${esc(directSource)}直飞参考价 ${esc(q.from.city)} → ${esc(q.to.city)}</div>
        <div class="value">${fmtMoney(direct.price)}</div>
        <div class="sub">${esc(direct.airlineName)} ${esc(direct.flightNo)} · ${direct.depTime} → ${direct.arrTime}</div>
      </div>
      <div class="summary-card highlight">
        <div class="label">💡 甩尾全程票（买 ${esc(q.from.city)}→${esc(q.to.city)}→${esc(bestDeal ? bestDeal.skipCity : '…')}）</div>
        <div class="value">${bestDeal ? fmtMoney(bestDeal.totalPrice) : '—'}</div>
        <div class="sub">${bestDeal ? esc([quoteSources[bestDeal.source], ...bestDeal.legs.map((l) => l.flightNo)].filter(Boolean).join(' · ')) : ''}</div>
      </div>
      <div class="save-big">
        ${bestDeal
          ? `<div class="save-amount">参考差价 ${fmtMoney(bestDeal.saveAmount)}</div>
             <div class="save-note">${bestDeal.savePercent}% · 只飞到 ${esc(q.to.city)} 就下机，后续 ${esc(bestDeal.skipCity)} 段不坐</div>`
          : `<div class="save-amount" style="color:var(--muted)">暂无差价</div>
             <div class="save-note">换一个枢纽城市目的地试试</div>`}
      </div>`;

    // 方案列表
    if (data.deals.length) {
      dealList.innerHTML = data.deals.map((d, i) => dealCardHtml(d, i, q)).join('');
      bindDealActions();
    } else {
      emptyState.hidden = false;
      emptyState.innerHTML = `
        <div class="empty-icon">🔍</div>
        <h3>当日暂无划算的甩尾方案</h3>
        <p>${esc(data.emptyReason || '该路线暂时没有发现甩尾差价。')}</p>`;
    }

    // 直飞参考
    if (data.direct.options && data.direct.options.length) {
      directPanel.hidden = false;
      directPanel.innerHTML = `
        <summary>直飞航班参考（最低 ${fmtMoney(data.direct.best.price)}） <span class="chev">▾</span></summary>
        <table class="direct-table">
          <thead><tr><th>航班</th><th>时间</th><th>时长</th><th>价格</th></tr></thead>
          <tbody>${data.direct.options.slice(0, 8).map((o) => `
            <tr>
              <td><b>${esc(o.airlineName)} ${esc(o.flightNo)}</b> <span style="color:var(--muted)">${esc(o.from.city)} → ${esc(o.to.city)}</span></td>
              <td>${o.depTime} → ${o.arrTime}</td>
              <td>${o.durationMin ? fmtDur(o.durationMin) : '—'}</td>
              <td><b>${fmtMoney(o.price)}</b></td>
            </tr>`).join('')}</tbody>
        </table>`;
    }
  }

  function routeSvg(d) {
    const from = d.legs[0].from;
    const dest = d.legs[0].to;
    const tail = d.legs[1].to;
    return `
      <svg class="route-diagram" viewBox="0 0 300 118" role="img" aria-label="航线示意：${from.city}到${dest.city}下机，${tail.city}段不坐">
        <defs>
          <linearGradient id="g${d.id}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#6366f1"/>
          </linearGradient>
        </defs>
        <line x1="52" y1="52" x2="150" y2="52" stroke="url(#g${d.id})" stroke-width="3"/>
        <line x1="150" y1="52" x2="248" y2="52" stroke="#cbd5e1" stroke-width="3" stroke-dasharray="7 6"/>
        <circle cx="52" cy="52" r="15" fill="#0f172a" stroke="#38bdf8" stroke-width="2.5"/>
        <text x="52" y="56" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">${from.code}</text>
        <circle cx="150" cy="52" r="19" fill="#38bdf8" stroke="#fff" stroke-width="3"/>
        <text x="150" y="56" text-anchor="middle" fill="#0f172a" font-size="11" font-weight="800">${dest.code}</text>
        <circle cx="248" cy="52" r="15" fill="#1e293b" stroke="#94a3b8" stroke-width="2"/>
        <text x="248" y="56" text-anchor="middle" fill="#cbd5e1" font-size="10" font-weight="700">${tail.code}</text>
        <text x="52" y="86" text-anchor="middle" fill="#64748b" font-size="10">${from.city}</text>
        <text x="150" y="86" text-anchor="middle" fill="#0369a1" font-size="10" font-weight="700">${dest.city} · 下机</text>
        <text x="248" y="86" text-anchor="middle" fill="#94a3b8" font-size="10">${tail.city} ✕</text>
        <text x="96" y="34" text-anchor="middle" fill="#0284c7" font-size="9">飞 ✓</text>
        <text x="204" y="34" text-anchor="middle" fill="#94a3b8" font-size="9">不坐 ✕</text>
      </svg>`;
  }

  function dealCardHtml(d, i, q) {
    const [l1, l2] = d.legs;
    const top = d.rank === 1 && d.saveAmount >= 50;
    const typeLabel = { hidden: '甩尾巴', intl: '甩国际段', roundtrip: '甩返程' }[d.dealType] || '甩尾巴';
    const quoteSource = quoteSources[d.source];
    const { through, direct } = d.booking;
    const route = `${q.from.city}(${q.from.code}) → ${q.to.city}(${q.to.code}) → ${l2.to.city}(${l2.to.code})`;
    const flightNos = [l1.flightNo, l2.flightNo].filter(Boolean).join(' + ');
    const dates = `${q.date} 出发${d.returnDate ? `，${d.returnDate} 返程` : ''}`;
    const prices = `${quoteSource}全程参考价 ${fmtMoney(d.totalPrice)}，${direct.provider}直飞参考价 ${fmtMoney(d.directPrice)}，参考差价 ${fmtMoney(d.saveAmount)}。`;
    const copyText = [dates, route, flightNos, prices].filter(Boolean).join(' · ');
    const fetchedAt = d.fetchedAt
      ? (() => { const t = new Date(d.fetchedAt); const p = (n) => String(n).padStart(2, '0'); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`; })()
      : '';
    return `
      <article class="deal-card ${top ? 'top' : ''}">
        <div class="route-wrap">${routeSvg(d)}</div>
        <div class="deal-mid">
          <h3 class="deal-title">${esc(q.from.city)} → <span class="dest">${esc(q.to.city)}</span>（在 ${esc(q.to.city)} 下机）<span class="deal-type-tag" data-type="${esc(d.dealType || 'hidden')}">${typeLabel}</span></h3>
          <p class="deal-tagline">买 ${esc(q.from.city)}→${esc(q.to.city)}→${esc(d.skipCity)} 全程票 · 甩掉最后一段</p>
          <div class="flight-rows">
            <div class="flight-row">
              <span class="airline">${esc(l1.airlineName)}</span><span class="no">${esc(l1.flightNo)}</span>
              <span class="times">${l1.depTime} <span class="arrow">→</span> ${l1.arrTime}</span>
              <span class="city">${esc(l1.from.city)} · ${esc(l1.to.city)}</span>
              <span class="skip-tag" style="background:var(--green-bg);color:#047857">你坐这段</span>
            </div>
            <div class="flight-row skip">
              <span class="airline">${esc(l2.airlineName)}</span><span class="no">${esc(l2.flightNo || '—')}</span>
              <span class="times">${l2.depTime} <span class="arrow">→</span> ${l2.arrTime}</span>
              <span class="city">${esc(l2.from.city)} · ${esc(l2.to.city)}</span>
              <span class="skip-tag">不坐 ✕</span>
            </div>
          </div>
          <p class="layover">${d.timingUnknown ? '中转等待与全程时长以购票网站为准' : `中转等待约 ${fmtDur(d.layoverMin)} · 全程 ${fmtDur(l1.durationMin + l2.durationMin + d.layoverMin)}`}</p>
          <p class="deal-tip">💡 ${esc(d.tip)}</p>
          ${fetchedAt ? `<p class="fetched-at">抓取于 ${fetchedAt} · 特价可能已变动</p>` : ''}
        </div>
        <div class="deal-right">
          <div class="through-price">${fmtMoney(d.totalPrice)} <small>${esc(quoteSource)}全程参考价</small></div>
          <div class="direct-compare">${esc(direct.provider)}直飞参考价 ${fmtMoney(d.directPrice)}</div>
          <span class="save-pill">参考差价 ${fmtMoney(d.saveAmount)} · ${d.savePercent}%</span>
          <div class="deal-actions">
            <a class="btn-primary" href="${esc(through.ctrip)}" target="_blank" rel="noopener">去${esc(through.provider)}核价</a>
            <a class="btn-ghost" href="${esc(direct.ctrip)}" target="_blank" rel="noopener">直飞核价</a>
            <button class="btn-copy" data-copy="${esc(copyText)}">复制</button>
          </div>
          <p class="link-note">${esc(through.note || '')}</p>
        </div>
      </article>`;
  }

  function bindDealActions() {
    $$('.btn-copy').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy);
          const old = btn.textContent;
          btn.textContent = '已复制 ✓';
          setTimeout(() => (btn.textContent = old), 1500);
        } catch {
          btn.textContent = '复制失败';
        }
      });
    });
  }

  // ---------- 初始化 ----------
  async function init() {
    dateInput.value = defaultDate();
    bindSuggest(fromInput, 'from', 'to');
    bindSuggest(toInput, 'to', 'from');
    try {
      const res = await fetch('/api/cities');
      const data = await res.json();
      cities = data.cities || [];
      readUrlParams();
      if (!selected.from || !selected.to) {
        // 默认示例
        window.__selectCity('from', 'CAN');
        window.__selectCity('to', 'PEK');
      } else {
        doSearch(); // 带 URL 参数访问时自动搜索，方便分享
      }
    } catch {
      statusText.textContent = '城市数据加载失败';
      statusBadge.classList.add('warn');
    }
  }

  init();
})();
