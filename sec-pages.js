(() => {
  const home = 'https://www.sec.gov/edgar/search/';
  const time = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' });
  const dateIsValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
  const error = (status, code, message) => Response.json({ status: 'error', code, message, source_url: home }, { status });

  async function shard(key) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    return (hash[0] % 64).toString(16).padStart(2, '0');
  }

  window.secPagesRequest = async (params, signal, gatewayFailed) => {
    const q = params.q.trim().normalize('NFKC').toUpperCase().replaceAll('.', '-');
    const numeric = /^[0-9]{1,10}$/.test(q);
    if ((!numeric && !/^[A-Z][A-Z0-9-]{0,14}$/.test(q)) || (numeric && Number(q) === 0)) {
      return error(400, 'invalid_query', '미국 종목 티커 또는 최대 10자리 CIK를 입력해 주세요.');
    }
    async function read(path) {
      const response = await fetch(new URL(path, document.baseURI), { cache: 'no-store', signal });
      if (!response.ok) throw new Error('SEC index unavailable');
      return response.json();
    }
    try {
      const key = 't:' + q;
      const [status, directory] = await Promise.all([
        read('./data/sec-recent/status.json'),
        numeric ? null : read('./data/disclosure-catalog/sec-' + await shard(key) + '.json'),
      ]);
      const candidate = directory?.[key]?.[0];
      if (!numeric && !candidate) return error(404, 'issuer_not_found', 'SEC 종목을 찾지 못했습니다. 티커를 확인해 주세요.');
      const cik = numeric ? q.padStart(10, '0') : candidate[0];
      const start = params.start || status.start;
      const end = params.end || status.end;
      const type = params.type || '';
      const page = Number(params.page || 1);
      if (![start, end].every(dateIsValid) || start > end || (type && !/^[A-Z0-9][A-Z0-9 -]{0,14}(?:\/A)?$/.test(type)) ||
          !Number.isSafeInteger(page) || page < 1) {
        return error(400, 'invalid_query', '조회 기간과 공시 유형을 확인해 주세요.');
      }
      if (start < status.start || end > status.end) return error(422, 'outside_snapshot',
        `저장 공시 조회 가능 기간은 ${status.start} ~ ${status.end}입니다. 다른 기간은 SEC 공식 사이트에서 확인해 주세요.`);
      const index = await read('./data/sec-recent/' + await shard(cik) + '.json');
      const record = index[cik];
      if (!record && numeric) {
        return error(404, 'issuer_not_found', '이 CIK로 수집한 최근 공시를 찾지 못했습니다. SEC 원문에서 확인해 주세요.');
      }
      const filings = record?.[1] || [];
      const matching = filings.filter(([date, form]) => date >= start && date <= end &&
        (!type || form === type || (form.endsWith('/A') && form.slice(0, -2) === type)));
      const pageSize = 10;
      const items = matching.slice((page - 1) * pageSize, page * pageSize).map(([filed, form, filename]) => ({
        filed, form, url: 'https://www.sec.gov/Archives/' + filename,
      }));
      return Response.json({ name: candidate?.[1] || record[0], cik, start, end, items,
        page, total: matching.length, total_pages: Math.ceil(matching.length / pageSize),
        source_url: 'https://www.sec.gov/edgar/browse/?CIK=' + Number(cik) + '&owner=exclude',
        _refresh: (gatewayFailed ? '실시간 공시 연결 지연 · ' : '') + 'SEC 색인 수집본 · ' +
          time.format(new Date(status.checked_at)) + ' (한국시간)',
      });
    } catch {
      return error(503, 'snapshot_unavailable', 'SEC 수집 공시를 불러오지 못했습니다. 공식 사이트에서 조회해 주세요.');
    }
  };
})();
