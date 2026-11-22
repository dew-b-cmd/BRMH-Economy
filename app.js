'use strict';

const { sources } = window.workspaceData;
const $ = id => document.getElementById(id);
if (location.pathname.startsWith('/kronos/')) $('classroom').hidden = false;
function make(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function card(title, label, text, url, linkText) {
  const item = make('article', '', 'card');
  const link = make('a', linkText);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  item.append(make('span', label, 'tag'), make('h3', title), make('p', text), link);
  return item;
}

const beauty = sources.find(source => source.id === 'ECON-DATA-KBEAUTY-2025');
const chips = sources.find(source => source.id === 'ECON-DATA-CHIPS-2025H1');
const dart = sources.find(source => source.id === 'ECON-GUIDE-DART');
$('briefs').append(
  card('화장품 수출, 114억 달러', '화장품 · ' + beauty.period,
    '전년 대비 11.8% 증가. 관심 기업의 해외 매출도 같은 방향으로 움직였는지 공시에서 확인해 보세요.', beauty.url, '식약처 발표 보기'),
  card('반도체 수출, 733억 달러', '반도체 · ' + chips.period,
    '전년 동기 대비 11.4% 증가. 산업 수출이 늘었을 때도 기업별 제품 구성과 실적은 따로 비교합니다.', chips.url, '산업통상부 발표 보기'),
  card('산업 변화가 기업 실적으로 이어졌나?', '공시 읽기',
    'DART에서 같은 분기의 연결 매출·영업이익을 비교하세요. 누적 실적과 분기 단독 실적은 구분합니다.', dart.url, 'OpenDART 열기')
);

function showSources() {
  const query = $('source-search').value.trim().toLowerCase();
  const found = sources.filter(source => (source.title + ' ' + source.text).toLowerCase().includes(query));
  $('source-list').replaceChildren(...found.map(source => card(
    source.title, source.period || '공식 출처', source.text, source.url, '출처 열기'
  )));
  if (!found.length) $('source-list').append(make('p', '일치하는 출처가 없습니다.'));
}

$('source-search').addEventListener('input', showSources);
showSources();

const reportStatus = $('reports-status');
const reportList = $('reports-list');
const reportDate = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Seoul' });
const reportTime = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' });
let reportRefreshRunning = false;

function reportLink(text, url) {
  const link = make('a', text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function showReports(snapshot) {
  if (!snapshot?.feeds?.length) {
    reportStatus.textContent = '리포트 첫 조회를 기다리고 있습니다.';
    return;
  }
  const checked = new Date(snapshot.checked);
  const stale = Date.now() - checked.getTime() > 30 * 60000;
  reportStatus.textContent = `${stale ? '마지막 조회' : '조회 시각'} ${reportTime.format(checked)} (한국시간) · 발행처 목록은 원문에서 확인`;
  reportList.replaceChildren(...snapshot.feeds.map(feed => {
    const card = make('section', '', 'card report-card');
    card.append(make('h3', feed.label));
    if (feed.status === 'cached' || (feed.status === 'ok' && stale)) {
      card.append(make('p', `이전 조회 자료 · ${reportTime.format(new Date(feed.updated))}`, 'fine muted'));
    }
    if (!feed.items.length) {
      card.append(make('p', '현재 목록을 가져오지 못했습니다.', 'fine muted'));
    } else {
      const entries = make('ul', '', 'feed-list report-entries');
      for (const item of feed.items) {
        const row = make('li');
        const date = make('time', reportDate.format(new Date(item.published)), 'fine muted');
        date.dateTime = item.published;
        row.append(reportLink(item.title, item.url), date);
        entries.append(row);
      }
      card.append(entries);
    }
    card.append(reportLink('발행처 목록 열기', feed.home));
    return card;
  }));
}

showReports(window.marketReports);
