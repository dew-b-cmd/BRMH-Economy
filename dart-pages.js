(() => {
  const home = 'https://dart.fss.or.kr/';
  const clock = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul',
  });
  const iso = date => date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const dateIsValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
  const error = (status, code, message, details = {}) => Response.json(
    { status: 'error', code, message, source_url: home, ...details }, { status },
  );

  async function shard(key) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    return (digest[0] % 64).toString(16).padStart(2, '0');
  }

  window.dartPagesRequest = async (params, signal, gatewayFailed) => {
    const q = params.q.trim().normalize('NFKC');
    if (!q || q.length > 64 || /[\p{C}<>]/u.test(q)) {
      return error(400, 'invalid_query', '기업명 또는 종목코드를 확인해 주세요.');
    }
    if (/^\d+$/.test(q) && !/^\d{6}(?:\d{2})?$/.test(q)) {
      return error(400, 'invalid_query', '국내 종목코드 6자리 또는 기업 고유번호 8자리를 입력해 주세요.');
    }
    async function get(path) {
      const response = await fetch(new URL(path, document.baseURI), { cache: 'no-store', signal });
      if (!response.ok) throw new Error('OpenDART snapshot unavailable');
      return response.json();
    }
    try {
      const key = /^\d{8}$/.test(q) ? 'c:' + q : /^\d{6}$/.test(q) ? 's:' + q :
        'n:' + q.replace(/\s+/g, '').toLowerCase().replace(/주식회사|㈜|\(주\)/g, '');
      const [directory, status] = await Promise.all([
        get('./data/disclosure-catalog/dart-' + await shard(key) + '.json'),
        get('./data/dart-recent/status.json'),
      ]);
      const earliest = iso(status.start);
      const latest = iso(status.end);
      const start = params.start || earliest;
      const end = params.end || latest;
      const type = params.type || '';
      const page = Number(params.page || 1);
      if (![start, end].every(dateIsValid) || start > end || (type && !/^[A-J]$/.test(type)) ||
          !Number.isSafeInteger(page) || page < 1) {
        return error(400, 'invalid_query', '조회 기간과 공시 유형을 확인해 주세요.');
      }
      if (start < earliest || end > latest) return error(422, 'outside_snapshot',
        `저장 공시 조회 가능 기간은 ${earliest} ~ ${latest}입니다. 다른 기간은 DART 공식 사이트에서 확인해 주세요.`);
      const candidates = directory[key] || [];
      if (!candidates.length) return error(404, 'issuer_not_found', '기업을 찾지 못했습니다. 회사명 또는 코드를 확인해 주세요.');
      if (candidates.length > 1) return error(409, 'ambiguous_issuer',
        '같은 이름의 기업이 여러 곳입니다. 목록의 고유번호로 다시 조회해 주세요.',
        { candidates: candidates.slice(0, 10).map(([code, name]) => ({ code, name })) });
      const [code, name, stock] = candidates[0];
      const lookup = await get('./data/dart-recent/' + await shard(code) + '.json');
      const matching = (lookup[code] || []).filter(([date, , , kinds]) =>
        date >= start.replaceAll('-', '') && date <= end.replaceAll('-', '') && (!type || kinds.includes(type)));
      const pageSize = 10;
      const items = matching.slice((page - 1) * pageSize, page * pageSize).map(([received, receipt, report]) => ({
        receipt, received, report, company: name, url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + receipt,
      }));
      return Response.json({ name, corp_code: code, stock_code: stock, start, end, items,
        page, total: matching.length, total_pages: Math.ceil(matching.length / pageSize),
        _refresh: (gatewayFailed ? '실시간 공시 연결 지연 · ' : '') + 'OpenDART 수집본 · ' +
          clock.format(new Date(status.checked_at)) + ' (한국시간)',
      });
    } catch {
      return error(503, 'snapshot_unavailable', 'OpenDART 저장 공시를 불러오지 못했습니다. 공식 사이트에서 조회해 주세요.');
    }
  };
})();
