// Fetch a public snapshot; no keys or API credentials are sent by the browser.
(() => {
  const snapshotURL = new URL('./data/economy.json', document.baseURI);
  const gatewayRoot = document.querySelector('meta[name="disclosure-api"]')?.content;
  const snapshotTime = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul',
  });
  const unavailable = (message = '공개판에서 수집된 자료를 찾지 못했습니다. 발행처 원문을 확인해 주세요.') => Response.json({status:'unavailable', message}, {status:404});
  const secOfficial = 'https://www.sec.gov/edgar/search/';
  const dartOfficial = 'https://dart.fss.or.kr/';
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
  async function readSnapshot(options) {
    const response = await fetch(snapshotURL, {cache:'no-store',signal:options.signal});
    if (!response.ok) throw new Error('경제 데이터 파일을 읽지 못했습니다.');
    const data = await response.json();
    const briefingNote = document.getElementById('pages-data-note');
    const checked = new Date(data.checked);
    if (briefingNote?.firstChild?.nodeType === Node.TEXT_NODE && Number.isFinite(checked.getTime())) {
      briefingNote.firstChild.nodeValue = `브리핑 갱신 확인 ${snapshotTime.format(checked)} (한국시간) · 출처별 갱신 상태는 각 항목에서 확인할 수 있습니다. `;
    }
    return data;
  }
  async function lookup(route, q, source, options, apiParams) {
    let failure;
    try {
      const target = new URL(route, gatewayRoot);
      target.search = new URLSearchParams(apiParams);
      const response = await fetch(target, { signal: options.signal, cache: 'no-store', credentials: 'omit' });
      if (response.status < 500) return response;
      failure = response;
    } catch {
      failure = Response.json({ status: 'error', code: 'gateway_unavailable', source_url: source,
        message: '공시 검색 서버에 연결하지 못했습니다. 아래 공식 사이트에서 확인해 주세요.' }, { status: 503 });
    }
    // The briefing stores a few SEC issuers. Only an exact, unfiltered match may be shown as a fallback.
    if (route === '/v1/sec/filings' && !apiParams.start && !apiParams.end && !apiParams.type && Number(apiParams.page || 1) === 1) {
      try {
        const snapshot = await readSnapshot(options);
        const normalized = q.trim().toUpperCase();
        const entry = Object.entries(snapshot.sec ?? {}).find(([symbol, item]) =>
          symbol === normalized || (/^[0-9]{1,10}$/.test(normalized) && item.cik === normalized.padStart(10,'0')));
        if (entry) {
          const problem = await failure.clone().json();
          return Response.json({ ...entry[1], annual: null,
          source_url: `https://www.sec.gov/edgar/browse/?CIK=${Number(entry[1].cik)}&owner=exclude`,
          _refresh: `${problem.message} · 해당 기업의 저장 공시 · ${statusLine(snapshot, ['sec:' + entry[0]])}` });
        }
      } catch { /* Keep the gateway's error when the snapshot is unavailable. */ }
    }
    return failure;
  }
  window.kronosPagesRequest = async (path, options = {}) => {
    const address = new URL(path, document.baseURI);
    const route = address.pathname.split('/api/').at(-1);
    const params = Object.fromEntries(address.searchParams);
    const company = params.q ?? params.corp_code;
    if (route === 'disclosures' && company?.trim()) {
      return lookup('/v1/dart/filings', company, dartOfficial, options, { ...params, q: company });
    }
    if (route === 'sec' || route === 'sec/analysis') {
      const q = params.q ?? params.symbol ?? '';
      return lookup(route === 'sec' ? '/v1/sec/filings' : '/v1/sec/analysis', q, secOfficial, options, { ...params, q });
    }
    const data = await readSnapshot(options);
    const read = (value, keys = []) => value ? Response.json({...value,_refresh:statusLine(data,keys)}) : unavailable();
    switch(route) {
      case 'exports': return read({items:data.exports,checked_at:data.checked},['exports:8542','exports:3304']);
      case 'disclosures': return read(data.dart,['dart']);
      case 'research/filing': return read(data.filing,['analysis:NVDA']);
      case 'research/industry': return read(data.industry,['exports:8542','production']);
      case 'research/sector': return read(data.sector,['sector']);
      case 'nvda/daily': return data.market ? read({...data.market,forecast_message:data.market.forecast_message || (!data.market.revision || data.forecast?.revision !== data.market.revision ? '현재 종가에 대응하는 Kronos 예측이 아직 없습니다.' : '')},['market','forecast']) : unavailable();
      case 'nvda/forecast': return data.forecast?.revision && data.forecast.revision === data.market?.revision ? read(data.forecast,['forecast']) : unavailable('현재 종가에 대응하는 예측이 없습니다.');
      default: return unavailable();
    }
  };
})();
