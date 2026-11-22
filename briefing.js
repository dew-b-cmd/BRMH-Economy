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
        return;
      }
      render(data, list, status);
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

  function renderDisclosures(data, list, status, corpCode) {
    const scope = corpCode ? '기업 ' + corpCode : '코스피·코스닥';
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
      (data.items.length ? ' · 최근 주요 공시 ' + data.items.length + '건' : ' · 조회된 주요 공시 없음');
    for (const item of data.items) {
      const entry = node('li', '', 'feed-entry');
      const form = item.form.replace(/\/A$/, '');
      const link = node('a', item.form + ' · ' + secForms[form] + (form !== item.form ? ' 정정' : ''));
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
  async function getExports() {
    refresh.disabled = true;
    try { await loadFeed('exports', '', renderExports); }
    finally { refresh.disabled = false; }
  }
  async function getDisclosures() {
    if (submit.disabled) return;
    const corpCode = byId('corp-code').value.trim();
    const query = corpCode ? '?' + new URLSearchParams({ corp_code: corpCode }) : '';
    submit.disabled = true;
    try {
      await loadFeed('disclosures', query, (data, list, status) => renderDisclosures(data, list, status, corpCode));
    } finally { submit.disabled = false; }
  }
  async function getSec() {
    if (secSubmit.disabled) return;
    const symbol = byId('sec-symbol').value.trim();
    selectedSecSymbol = '';
    secAnalysisButton.disabled = true;
    byId('sec-analysis-status').textContent = '';
    byId('sec-analysis-list').replaceChildren();
    secSubmit.disabled = true;
    try {
      await loadFeed('sec', '?' + new URLSearchParams({ symbol }), (data, list, status) => {
        renderSec(data, list, status);
        selectedSecSymbol = symbol;
        secAnalysisButton.disabled = !data.annual;
        if (!data.annual) byId('sec-analysis-status').textContent = '조회된 10-K 연차보고서가 없습니다.';
      });
    } finally { secSubmit.disabled = false; }
  }

  function renderSecAnalysis(data, list, status) {
    status.textContent = data.metrics.length
      ? data.name + ' · 회계연도 종료 ' + data.annual.period
      : '비교에 사용할 연간 SEC 수치를 찾지 못했습니다.';
    for (const metric of data.metrics) {
      const entry = node('div', '', 'feed-entry');
      entry.append(node('b', metric.label + ' · USD ' + usd.format(metric.value)));
      if (metric.prior_value !== null) {
        entry.append(node('small', '전년 ' + metric.prior_period + ' · USD ' + usd.format(metric.prior_value)));
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
        renderSecAnalysis, { path: 'sec/analysis', method: 'POST', timeout: 82000 });
    } finally {
      secAnalysisButton.disabled = false;
      secSubmit.disabled = false;
    }
  }

  refresh.addEventListener('click', getExports);
  form.addEventListener('submit', event => { event.preventDefault(); getDisclosures(); });
  secForm.addEventListener('submit', event => { event.preventDefault(); getSec(); });
  secAnalysisButton.addEventListener('click', getSecAnalysis);
  getExports();
  getDisclosures();
  getSec();
})();
