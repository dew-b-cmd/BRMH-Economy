'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const usd = new Intl.NumberFormat('ko-KR');
  const percent = new Intl.NumberFormat('ko-KR', { signDisplay: 'exceptZero', maximumFractionDigits: 2 });
  const day = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const month = value => value.slice(0, 4) + '년 ' + Number(value.slice(4)) + '월';
  const filingDate = value => value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const secForms = {
    '10-K': '연차보고서', '10-Q': '분기보고서', '8-K': '주요사항 공시',
    '20-F': '외국기업 연차보고서', '40-F': '캐나다 기업 연차보고서', '6-K': '외국기업 공시'
  };

  function node(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  async function loadFeed(name, query, render, { path = name, method = 'GET', timeout = 23000 } = {}) {
    const status = byId(name + '-status');
    const list = byId(name + '-list');
    status.textContent = '조회 중…';
    list.replaceChildren();
    try {
      const response = await window.kronosPagesRequest('./api/' + path + query, { method, signal: AbortSignal.timeout(timeout) });
      const data = await response.json();
      if (!response.ok) {
        status.textContent = data.status === 'setup' ? '연결 설정 필요 · ' + data.message : data.message;
        if (Array.isArray(data.candidates)) {
          for (const issuer of data.candidates) list.append(node('li', `${issuer.name} · ${issuer.code}`));
        }
        return;
      }
      render(data, list, status);
      window.economyRefreshStatus(data, status);
    } catch {
      status.textContent = '자료를 불러오지 못했습니다. 잠시 후 다시 조회하세요.';
    }
  }

  function renderExports(data, list, status) {
    status.textContent = '품목별 신고금액 · 미국 달러 · 조회 ' + day.format(new Date(data.checked_at)) + ' (한국시간)';
    for (const item of data.items) {
      const card = node('div', '', 'feed-entry');
      card.append(node('b', item.label + ' · HS ' + item.hs_code));
      if (item.status === 'ok') {
        card.append(
          node('small', month(item.month) + ' 수출액'),
          node('strong', usd.format(item.value_usd) + '달러', 'export-value'),
          node('p', item.yoy_percent === null ? '전년 동월 증감률을 표시할 수 없습니다.' :
            '전년 동월 대비 ' + percent.format(item.yoy_percent) + '%' + (item.comparison_month ? ' · ' + month(item.comparison_month) + ' ' + usd.format(item.comparison_usd) + '달러' : ''))
        );
      } else {
        card.append(node('p', item.status === 'empty' ? '최근 기준월에 조회된 통계가 없습니다.' : item.message));
      }
      list.append(card);
    }
  }

  function renderDisclosures(data, list, status, company) {
    const scope = company ? `${data.name} · 고유번호 ${data.corp_code}` : '코스피·코스닥';
    status.textContent = scope + ' · 접수 ' + data.start + ' ~ ' + data.end +
      (data.items.length ? '' : ' · 접수된 공시 없음');
    for (const item of data.items) {
      const entry = node('li', '', 'feed-entry');
      const link = node('a', item.report);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      entry.append(node('small', filingDate(item.received) + ' · ' + item.company), link);
      list.append(entry);
    }
  }

  function renderSec(data, list, status) {
    status.textContent = data.name + ' · CIK ' + data.cik +
      (data.start ? ` · ${data.start} ~ ${data.end}` : '') +
      (data.items.length ? ' · 검색 결과 ' + (data.total ?? data.items.length) + '건' : ' · 해당 기간에 공시 없음');
    for (const item of data.items) {
      const entry = node('li', '', 'feed-entry');
      const form = item.form.replace(/\/A$/, '');
      const link = node('a', secForms[form] ? item.form + ' · ' + secForms[form] + (form !== item.form ? ' 정정' : '') : item.form);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      entry.append(node('small', item.filed + ' · SEC 접수일'), link);
      list.append(entry);
    }
  }

  const refresh = byId('refresh-exports');
  const form = byId('disclosure-search');
  const submit = form.querySelector('button');
  const secForm = byId('sec-search');
  const secSubmit = secForm.querySelector('button');
  const secAnalysisButton = byId('sec-analysis-button');
  let selectedSecSymbol = '';

  function searchParams(provider, company, page) {
    const params = new URLSearchParams({ q: company, page });
    for (const key of ['start', 'end', 'type']) {
      const value = byId(provider + '-' + key).value;
      if (value) params.set(key, value);
    }
    return '?' + params;
  }

  function pagination(provider, data, load) {
    const panel = byId(provider + '-pages');
    panel.replaceChildren();
    panel.hidden = data.total_pages <= 1 || !data.total_pages;
    if (panel.hidden) return;
    const before = node('button', '이전');
    const after = node('button', '다음');
    before.disabled = data.page <= 1;
    after.disabled = data.page >= data.total_pages;
    before.addEventListener('click', () => load(data.page - 1));
    after.addEventListener('click', () => load(data.page + 1));
    panel.append(before, node('span', `${data.page} / ${data.total_pages} 페이지`), after);
  }
  async function getExports() {
    refresh.disabled = true;
    try { await loadFeed('exports', '', renderExports); }
    finally { refresh.disabled = false; }
  }
  async function getDisclosures(page = 1) {
    if (submit.disabled) return;
    const company = byId('corp-code').value.trim();
    const query = company ? searchParams('dart', company, page) : '';
    pagination('dart', {}, getDisclosures);
    if (!company && ['start', 'end', 'type'].some(key => byId('dart-' + key).value)) {
      byId('disclosures-list').replaceChildren();
      byId('disclosures-status').textContent = '기간과 공시 유형을 선택하려면 회사명 또는 코드를 입력해 주세요.';
      return;
    }
    submit.disabled = true;
    try {
      await loadFeed('disclosures', query, (data, list, status) => {
        renderDisclosures(data, list, status, company);
        if (company === byId('corp-code').value.trim() && query === searchParams('dart', company, page)) {
          pagination('dart', data, getDisclosures);
        }
      });
    } finally { submit.disabled = false; }
  }
  async function getSec(page = 1) {
    if (secSubmit.disabled) return;
    const symbol = byId('sec-symbol').value.trim();
    const query = searchParams('sec', symbol, page);
    selectedSecSymbol = '';
    byId('sec-official').href = 'https://www.sec.gov/edgar/search/';
    secAnalysisButton.disabled = true;
    byId('sec-analysis-status').textContent = '';
    byId('sec-analysis-list').replaceChildren();
    pagination('sec', {}, getSec);
    secSubmit.disabled = true;
    try {
      await loadFeed('sec', query, (data, list, status) => {
        renderSec(data, list, status);
        if (symbol === byId('sec-symbol').value.trim() && query === searchParams('sec', symbol, page)) {
          pagination('sec', data, getSec);
        }
        byId('sec-official').href = data.source_url || 'https://www.sec.gov/edgar/search/';
        selectedSecSymbol = data.cik;
        secAnalysisButton.disabled = !data.annual;
        if (!data.annual && !data._refresh) byId('sec-analysis-status').textContent = '분석할 연차보고서를 찾지 못했습니다.';
      });
    } finally { secSubmit.disabled = false; }
  }

  function renderSecAnalysis(data, list, status) {
    status.textContent = data.metrics.length
      ? data.name + ' · 회계연도 종료 ' + data.annual.period
      : '비교에 사용할 연간 SEC 수치를 찾지 못했습니다.';
    for (const metric of data.metrics) {
      const entry = node('div', '', 'feed-entry');
      const unit = metric.unit || 'USD';
      entry.append(node('b', metric.label + ' · ' + unit + ' ' + usd.format(metric.value)));
      if (metric.prior_value !== null) {
        entry.append(node('small', '전년 ' + metric.prior_period + ' · ' + unit + ' ' + usd.format(metric.prior_value)));
      }
      const change = metric.change_pct === null ? '전년 대비 증감률을 표시할 수 없습니다.'
        : '전년 대비 ' + percent.format(metric.change_pct) + '%';
      entry.append(node('small', change), node('small', 'SEC 항목 · ' + metric.tag));
      list.append(entry);
    }
    if (data.annual) {
      const source = node('a', 'SEC 10-K 원문');
      source.href = data.annual.url;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      list.append(source);
    }
    if (data.commentary) {
      const explanation = data.commentary;
      if (explanation.status === 'ok') list.append(node('b', 'Fastino AI 해설'));
      list.append(node('p', explanation.text || explanation.message, 'fine'));
    }
  }

  async function getSecAnalysis() {
    if (!selectedSecSymbol || secAnalysisButton.disabled) return;
    secAnalysisButton.disabled = true;
    secSubmit.disabled = true;
    try {
      await loadFeed('sec-analysis', '?' + new URLSearchParams({ symbol: selectedSecSymbol }),
        renderSecAnalysis, { path: 'sec/analysis', timeout: 28000 });
    } finally {
      secAnalysisButton.disabled = false;
      secSubmit.disabled = false;
    }
  }

  refresh.addEventListener('click', getExports);
  form.addEventListener('submit', event => { event.preventDefault(); getDisclosures(); });
  secForm.addEventListener('submit', event => { event.preventDefault(); getSec(); });
  form.addEventListener('input', () => pagination('dart', {}, getDisclosures));
  secForm.addEventListener('input', () => pagination('sec', {}, getSec));
  secAnalysisButton.addEventListener('click', getSecAnalysis);
  getExports();
  getDisclosures();
  getSec();
})();
