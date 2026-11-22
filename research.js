'use strict';

(() => {
  const byId = id => document.getElementById(id);
  if (location.pathname.startsWith('/kronos/')) byId('classroom-link').href = '../?lesson=bottomup';
  const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
  const signed = new Intl.NumberFormat('ko-KR', { signDisplay: 'exceptZero', maximumFractionDigits: 2 });
  const money = value => value == null ? '—' : 'USD ' + number.format(value);
  const percent = value => value == null ? '—' : signed.format(value) + '%';
  const month = value => value.slice(0, 4) + '-' + value.slice(-2);

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function source(url, label) {
    const link = element('a', label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function table(headers, rows) {
    const wrapper = element('div', null, 'table-wrap');
    const grid = element('table', null, 'research-table');
    const heading = element('tr');
    for (const label of headers) {
      const cell = element('th', label);
      cell.scope = 'col';
      heading.append(cell);
    }
    grid.createTHead().append(heading);
    const body = grid.createTBody();
    for (const values of rows) {
      const row = body.insertRow();
      for (const value of values) row.append(element('td', value));
    }
    wrapper.append(grid);
    return wrapper;
  }

  async function load(name, render) {
    const status = byId(name + '-status');
    const content = byId(name + '-content');
    content.replaceChildren();
    status.textContent = '공식 자료 조회 중…';
    try {
      const response = await window.kronosPagesRequest('./api/research/' + name, {
        signal: AbortSignal.timeout(24000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '자료를 읽지 못했습니다.');
      status.textContent = '';
      render(data, content, status);
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' ? '응답이 지연되고 있습니다. 다시 조회하세요.' : error.message;
    }
  }

  function filing(data, content, status) {
    if (!data.annual) {
      status.textContent = '연간 10-K 자료를 찾지 못했습니다.';
      return;
    }
    status.textContent = data.name + ' · 회계연도 종료 ' + data.annual.period + ' · SEC 접수 ' + data.annual.filed;
    if (data.metrics.length) {
      content.append(table(['항목', '해당 회계연도', '전년 비교 수치', '증감률'], data.metrics.map(row =>
        [row.label, money(row.value), money(row.prior_value), percent(row.change_pct)])));
    } else {
      content.append(element('p', '이 보고서와 연결되는 표준 재무 항목을 찾지 못했습니다.'));
    }
    content.append(source(data.annual.url, 'NVDA 10-K 원문 보기'));
  }

  function indicator(title, value, details, url, label) {
    const card = element('div', null, 'indicator');
    card.append(element('p', title), element('strong', value), element('p', details, 'fine'), source(url, label));
    return card;
  }

  function industry(data, content) {
    const exports = data.exports;
    const production = data.production;
    const hasExports = exports.status === 'ok';
    content.append(indicator('한국 전자집적회로 수출 · HS 8542',
      hasExports ? money(exports.value_usd) : '조회 자료 없음',
      hasExports ? month(exports.month) + ' · 전년 동월 대비 ' + percent(exports.yoy_percent)
        : exports.message || '최근 기준월에 관세청 통계가 없습니다.',
      'https://www.data.go.kr/data/15101609/openapi.do', '관세청 통계 출처'));
    content.append(indicator('미국 반도체·전자부품 생산지수',
      production ? number.format(production.value) : '조회 자료 없음',
      production ? production.month + ' · 전년 동월 대비 ' + percent(production.yoy_percent) + ' · 2017=100, 계절조정'
        : data.production_error,
      'https://fred.stlouisfed.org/series/IPG3344S', '연준 생산지수 원자료'));
  }

  function sector(data, content, status) {
    if (data.periods.length) {
      content.append(table(['기간', '비교월', '전자장비 업종', '미국 시장', '차이'], data.periods.map(row =>
        [row.months + '개월', month(row.start) + ' ~ ' + month(row.end), percent(row.industry),
          percent(row.market), signed.format(row.difference_pp) + '%p'])));
    } else {
      status.textContent = '공통 기준월의 수익률을 찾지 못했습니다.';
    }
    content.append(source(data.source, 'Kenneth R. French Data Library'));
  }

  const refresh = byId('refresh-evidence');
  async function getEvidence() {
    refresh.disabled = true;
    try {
      await Promise.allSettled([load('filing', filing), load('industry', industry), load('sector', sector)]);
    } finally {
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', getEvidence);
  getEvidence();
})();
