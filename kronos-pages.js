// Fetch a public snapshot; no keys or API credentials are sent by the browser.
(() => {
  const snapshotURL = new URL('./data/economy.json', document.baseURI);
  const snapshotTime = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul',
  });
  const unavailable = (message = '공개판에서 수집된 자료를 찾지 못했습니다. 발행처 원문을 확인해 주세요.') => Response.json({status:'unavailable', message}, {status:404});
  const symbolFor = value => {
    const search = (value || '').trim().toUpperCase();
    if (search === 'NVDA' || /^0*1045810$/.test(search)) return 'NVDA';
    if (search === 'AAPL' || /^0*320193$/.test(search)) return 'AAPL';
    return '';
  };
  const statusLine = (data, keys) => keys.map(key => {
    const row = data.refresh?.[key];
    if (!row) return '';
    const labels = {ok:'갱신 성공',cached:'수집 실패 · 이전 자료',error:'수집 실패',setup:'연결 설정 필요',baseline:'초기 저장본',pending:'새 데이터 대기'};
    const time = row.last_success ? new Date(row.last_success).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}) : '자동 갱신 기록 없음';
    return key + ' · ' + (labels[row.state] || row.state) + ' · 마지막 성공 ' + time;
  }).filter(Boolean).join(' / ');
  window.economyRefreshStatus = (payload, element) => {
    if (payload?._refresh) element.textContent += (element.textContent ? ' · ' : '') + payload._refresh;
  };
  window.kronosPagesRequest = async (path, options = {}) => {
    const response = await fetch(snapshotURL, {cache:'no-store',signal:options.signal});
    if (!response.ok) throw new Error('경제 데이터 파일을 읽지 못했습니다.');
    const data = await response.json();
    const briefingNote = document.getElementById('pages-data-note');
    const checked = new Date(data.checked);
    if (briefingNote?.firstChild?.nodeType === Node.TEXT_NODE && Number.isFinite(checked.getTime())) {
      briefingNote.firstChild.nodeValue = `브리핑 갱신 확인 ${snapshotTime.format(checked)} (한국시간) · 출처별 갱신 상태는 각 항목에서 확인할 수 있습니다. `;
    }
    const read = (value, keys = []) => value ? Response.json({...value,_refresh:statusLine(data,keys)}) : unavailable();
    const address = new URL(path, document.baseURI);
    const symbol = symbolFor(address.searchParams.get('symbol'));
    switch(address.pathname.split('/api/').at(-1)) {
      case 'exports': return read({items:data.exports,checked_at:data.checked},['exports:8542','exports:3304']);
      case 'disclosures': return address.searchParams.has('corp_code') ? unavailable('공개판은 수집한 코스피·코스닥 공시를 표시합니다. 기업별 전체 조회는 DART에서 가능합니다.') : read(data.dart,['dart']);
      case 'sec': return read(data.sec?.[symbol],['sec:'+symbol]);
      case 'sec/analysis': return read(data.analysis?.[symbol],['analysis:'+symbol]);
      case 'research/filing': return read(data.filing,['analysis:NVDA']);
      case 'research/industry': return read(data.industry,['exports:8542','production']);
      case 'research/sector': return read(data.sector,['sector']);
      case 'nvda/daily': return data.market ? read({...data.market,forecast_message:data.market.forecast_message || (!data.market.revision || data.forecast?.revision !== data.market.revision ? '현재 종가에 대응하는 Kronos 예측이 아직 없습니다.' : '')},['market','forecast']) : unavailable();
      case 'nvda/forecast': return data.forecast?.revision && data.forecast.revision === data.market?.revision ? read(data.forecast,['forecast']) : unavailable('현재 종가에 대응하는 예측이 없습니다.');
      default: return unavailable();
    }
  };
})();
