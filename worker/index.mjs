const DART_HOME = 'https://dart.fss.or.kr/';
const SEC_HOME = 'https://www.sec.gov/edgar/search/';
const DART_API = 'https://opendart.fss.or.kr/api/list.json';
const SEC_DATA = 'https://data.sec.gov/';
const DAY = 86_400_000;
const routes = new Set(['/v1/dart/filings', '/v1/sec/filings', '/v1/sec/analysis']);
const datePattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const accessionPattern = /^[0-9]{10}-[0-9]{2}-[0-9]{6}$/;
const annualForms = new Set(['10-K', '20-F', '40-F']);

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function invalid(message) { return new ApiError(400, 'invalid_query', message); }
function limited() { return new ApiError(429, 'rate_limited', '조회 요청이 많습니다. 잠시 후 다시 시도하세요.'); }
function providerError() { return new ApiError(502, 'source_unavailable', '공시 기관에 연결하지 못했습니다. 공식 사이트에서도 확인할 수 있습니다.'); }
function authError() { return new ApiError(502, 'source_auth_error', '공시 기관의 API 인증 또는 접근 권한에 문제가 있습니다. 공식 사이트에서 조회해 주세요.'); }
function timeoutError() { return new ApiError(504, 'source_timeout', '공시 기관의 응답이 지연되고 있습니다.'); }
function iso(date) { return date.toISOString().slice(0, 10); }

function validDate(value) {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && iso(parsed) === value;
}

function today(timeZone, now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(name => parts.find(part => part.type === name).value).join('-');
}

function integer(value, min, max, label) {
  const number = Number(value);
  if (!/^[0-9]+$/.test(value) || number < min || number > max) throw invalid(label + ' 범위를 확인해 주세요.');
  return number;
}

function filters(params, provider, now) {
  const q = (params.get('q') ?? '').trim().normalize('NFKC');
  if (!q || q.length > 64 || /[\p{C}<>]/u.test(q)) throw invalid('기업명 또는 종목코드를 확인해 주세요.');
  if (provider === 'sec' && !/^(?:[0-9]{1,10}|[A-Za-z][A-Za-z0-9.-]{0,14})$/.test(q)) {
    throw invalid('미국 종목 티커 또는 최대 10자리 CIK를 입력해 주세요.');
  }
  if (provider === 'dart' && /^[0-9]+$/.test(q) && !/^[0-9]{6}(?:[0-9]{2})?$/.test(q)) {
    throw invalid('국내 종목코드 6자리 또는 기업 고유번호 8자리를 입력해 주세요.');
  }
  const current = today(provider === 'dart' ? 'Asia/Seoul' : 'America/New_York', now);
  const end = params.get('end') || current;
  if (!validDate(end) || end > current || end < '1994-01-01') throw invalid('종료일을 확인해 주세요.');
  const start = params.get('start') || iso(new Date(Date.parse(end) - (provider === 'dart' ? 29 : 89) * DAY));
  if (!validDate(start) || start < '1994-01-01' || start > end || Date.parse(end) - Date.parse(start) >= 366 * DAY) {
    throw invalid('시작일과 종료일을 확인해 주세요. 한 번에 최대 366일을 조회할 수 있습니다.');
  }
  const type = (params.get('type') ?? '').toUpperCase();
  if (type && !(provider === 'dart' ? /^[A-J]$/.test(type) : /^[A-Z0-9][A-Z0-9 -]{0,14}(?:\/A)?$/.test(type))) {
    throw invalid('공시 유형을 확인해 주세요.');
  }
  return { q: provider === 'sec' ? q.toUpperCase().replaceAll('.', '-') : q, start, end, type,
    page: integer(params.get('page') || '1', 1, 1000, '페이지'),
    size: integer(params.get('page_size') || '10', 1, 50, '페이지당 건수') };
}

async function getJson(fetcher, url, provider, env, sizeLimit = 8_000_000, decode = JSON.parse) {
  const headers = { Accept: 'application/json' };
  if (provider === 'sec') {
    if (!env.SEC_CONTACT_EMAIL) throw authError();
    headers['User-Agent'] = `BRMH Economy ${env.SEC_CONTACT_EMAIL}`;
  }
  if (provider !== 'catalog' && !(await env.PROVIDER_LIMIT.limit({ key: provider })).success) throw limited();
  let response;
  try {
    response = await fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw timeoutError();
    }
    throw providerError();
  }
  if (response.status === 401 || response.status === 403) throw authError();
  if (response.status === 429) throw limited();
  if (response.status === 404 && provider === 'sec' && /^\/submissions\/CIK[0-9]{10}\.json$/.test(new URL(url).pathname)) {
    throw new ApiError(404, 'issuer_not_found', 'SEC에서 해당 CIK를 찾지 못했습니다.');
  }
  if (!response.ok || Number(response.headers.get('Content-Length')) > sizeLimit) throw providerError();
  try {
    const raw = await response.text();
    if (raw.length > sizeLimit) throw providerError();
    return decode(raw);
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw timeoutError();
    throw providerError();
  }
}

export function dartNameKey(name) {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase().replace(/주식회사|㈜|\(주\)/g, '');
}

async function resolveIssuer(fetcher, env, provider, q) {
  if (provider === 'sec' && /^[0-9]+$/.test(q)) {
    if (Number(q) === 0) throw invalid('CIK는 0보다 커야 합니다.');
    return { code: q.padStart(10, '0') };
  }
  const key = provider === 'sec' ? 't:' + q : /^[0-9]{8}$/.test(q) ? 'c:' + q : /^[0-9]{6}$/.test(q) ? 's:' + q : 'n:' + dartNameKey(q);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  const location = new URL(`${provider}-${(hash[0] % 64).toString(16).padStart(2, '0')}.json`, env.CATALOG_BASE);
  const directory = await getJson(fetcher, location.href, 'catalog', env, 1_500_000);
  const matches = directory?.[key];
  if (!Array.isArray(matches) || !matches.length) {
    throw new ApiError(404, 'issuer_not_found', '기업을 찾지 못했습니다. 회사명 또는 코드를 확인해 주세요.');
  }
  if (matches.length > 1) {
    const candidates = matches.slice(0, 10).map(([code, name, symbol]) => ({ code, name, symbol }));
    throw new ApiError(409, 'ambiguous_issuer', '같은 이름의 기업이 여러 곳입니다. 목록의 고유번호로 검색해 주세요.', { candidates });
  }
  const [code, name, symbol] = matches[0];
  if (!(provider === 'sec' ? /^[0-9]{10}$/ : /^[0-9]{8}$/).test(code)) throw providerError();
  return { code, name, symbol };
}

async function dartFilings(fetcher, env, query) {
  if (!env.OPENDART_API_KEY) throw authError();
  const issuer = await resolveIssuer(fetcher, env, 'dart', query.q);
  const url = new URL(DART_API);
  url.search = new URLSearchParams({ crtfc_key: env.OPENDART_API_KEY, corp_code: issuer.code,
    bgn_de: query.start.replaceAll('-', ''), end_de: query.end.replaceAll('-', ''),
    page_no: String(query.page), page_count: String(query.size), sort: 'date', sort_mth: 'desc',
    ...(query.type ? { pblntf_ty: query.type } : {}) });
  const data = await getJson(fetcher, url.href, 'dart', env, 1_000_000);
  if (['010', '011', '012', '901'].includes(data.status)) throw authError();
  if (data.status === '020') throw limited();
  if (data.status !== '013' && (data.status !== '000' || !Array.isArray(data.list))) throw providerError();
  const items = (data.list ?? []).flatMap(row => {
    if (row.corp_code !== issuer.code || !/^[0-9]{14}$/.test(row.rcept_no) || !/^[0-9]{8}$/.test(row.rcept_dt)) return [];
    return [{ receipt: row.rcept_no, received: row.rcept_dt, company: row.corp_name, report: row.report_nm,
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.rcept_no}` }];
  });
  return { name: issuer.name, corp_code: issuer.code, stock_code: issuer.symbol, start: query.start, end: query.end,
    items, page: query.page, total_pages: Number(data.total_page ?? 0), total: Number(data.total_count ?? 0), source_url: DART_HOME };
}

function secRows(columns, cik) {
  if (!Array.isArray(columns?.form) || !Array.isArray(columns?.accessionNumber) || !Array.isArray(columns?.filingDate)) throw providerError();
  const rows = [];
  for (let i = 0; i < columns.form.length; i++) {
    const form = columns.form[i];
    const filed = columns.filingDate[i];
    const accession = columns.accessionNumber[i];
    const period = columns.reportDate?.[i];
    if (typeof form !== 'string' || !validDate(filed) || !accessionPattern.test(accession)) continue;
    const file = columns.primaryDocument?.[i];
    const primary = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(file ?? '') ? file : `${accession}-index.htm`;
    rows.push({ form, filed, accession, period: validDate(period) ? period : null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${primary}` });
  }
  return rows;
}

async function secSubmission(fetcher, env, query) {
  const issuer = await resolveIssuer(fetcher, env, 'sec', query.q);
  const data = await getJson(fetcher, `${SEC_DATA}submissions/CIK${issuer.code}.json`, 'sec', env);
  if (Number(data.cik) !== Number(issuer.code)) throw providerError();
  const rows = secRows(data.filings?.recent, issuer.code).sort((a, b) => b.filed.localeCompare(a.filed));
  const annual = rows.find(item => annualForms.has(item.form) && item.period) ?? null;
  return { data, issuer, rows, annual, source_url: `https://www.sec.gov/edgar/browse/?CIK=${Number(issuer.code)}&owner=exclude` };
}

async function secFilings(fetcher, env, query) {
  const { data, issuer, rows, annual, source_url } = await secSubmission(fetcher, env, query);
  const archives = (data.filings?.files ?? []).filter(file => file.filingTo >= query.start && file.filingFrom <= query.end);
  if (archives.length > 4) throw invalid('공시가 많은 기간입니다. 검색 기간을 더 좁혀 주세요.');
  for (const archive of archives) {
    if (!new RegExp(`^CIK${issuer.code}-[0-9]{3,}\\.json$`).test(archive.name)) throw providerError();
    const extra = await getJson(fetcher, SEC_DATA + 'submissions/' + archive.name, 'sec', env);
    rows.push(...secRows(extra, issuer.code));
  }
  const matched = new Map();
  for (const item of rows) {
    const typeMatches = !query.type || item.form === query.type ||
      (item.form.endsWith('/A') && item.form.slice(0, -2) === query.type);
    if (typeMatches && item.filed >= query.start && item.filed <= query.end) matched.set(item.accession, item);
  }
  const sorted = [...matched.values()].sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession));
  return { name: data.name, cik: issuer.code, annual, start: query.start, end: query.end, source_url,
    items: sorted.slice((query.page - 1) * query.size, query.page * query.size),
    page: query.page, total_pages: Math.ceil(sorted.length / query.size), total: sorted.length };
}

const metrics = [
  ['revenue', '매출', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenue']],
  ['operating_income', '영업이익', ['OperatingIncomeLoss', 'ProfitLossFromOperatingActivities']],
  ['net_income', '순이익', ['NetIncomeLoss', 'ProfitLoss']],
  ['operating_cash_flow', '영업활동 현금흐름', ['NetCashProvidedByUsedInOperatingActivities', 'CashFlowsFromUsedInOperatingActivities']],
];
const taxonomies = ['us-gaap', 'ifrs-full'];
const factTags = new Set(metrics.flatMap(([, , tags]) => tags));

export function selectCompanyFacts(raw, cik) {
  const found = /,"facts":\{/.exec(raw);
  if (found) {
    const header = JSON.parse(raw.slice(0, found.index) + '}');
    if (Number(header.cik) !== Number(cik)) throw providerError();
    const result = {};
    let cursor = found.index + found[0].length;
    // In EDGAR's compact encoding each concept ends with its last unit array,
    // the units object, and the concept object. Skip the observations of other tags.
    while (raw[cursor] === '"') {
      const keyEnd = raw.indexOf('":{', cursor + 1);
      if (keyEnd < 0) break;
      const tax = raw.slice(cursor + 1, keyEnd);
      const selected = taxonomies.includes(tax) ? (result[tax] = {}) : null;
      cursor = keyEnd + 3;
      while (raw[cursor] === '"') {
        const tagEnd = raw.indexOf('":{', cursor + 1);
        if (tagEnd < 0) break;
        const tag = raw.slice(cursor + 1, tagEnd);
        const close = raw.indexOf(']}}', tagEnd + 3);
        if (close < 0 || ![',', '}'].includes(raw[close + 3])) break;
        if (selected && factTags.has(tag)) selected[tag] = JSON.parse(raw.slice(tagEnd + 2, close + 3));
        cursor = close + 3;
        if (raw[cursor] !== ',') break;
        cursor++;
      }
      if (raw[cursor] !== '}') break;
      cursor++;
      if (raw[cursor] !== ',') break;
      cursor++;
    }
    if (raw.slice(cursor).trim() === '}}') return result;
  }
  const data = JSON.parse(raw);
  if (Number(data.cik) !== Number(cik)) throw providerError();
  return data.facts ?? {};
}

export function annualMetrics(facts, annual) {
  const results = [];
  for (const [id, label, tags] of metrics) {
    const candidates = [];
    for (const taxonomy of taxonomies) {
      for (const tag of tags) {
        const units = facts[taxonomy]?.[tag]?.units;
        if (!units) continue;
        for (const unit of Object.keys(units).sort((a, b) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))) {
          if (!/^[A-Z]{3}$/.test(unit) || !Array.isArray(units[unit])) continue;
          const periods = new Map();
          for (const row of units[unit]) {
            if (row.accn !== annual.accession || !Number.isFinite(row.val) || !validDate(row.start) || !validDate(row.end)) continue;
            const days = (Date.parse(row.end) - Date.parse(row.start)) / DAY + 1;
            if (days >= 350 && days <= 380) {
              if (!periods.has(row.end)) periods.set(row.end, new Set());
              periods.get(row.end).add(row.val);
            }
          }
          const values = periods.get(annual.period);
          if (values?.size !== 1) continue;
          const previous = [...periods.keys()].sort().reverse().find(date => {
            const gap = (Date.parse(annual.period) - Date.parse(date)) / DAY;
            return gap >= 350 && gap <= 380 && periods.get(date).size === 1;
          });
          const [value] = values;
          const prior = previous ? [...periods.get(previous)][0] : null;
          candidates.push({ id, label, tag, unit, value, prior_value: prior, prior_period: previous ?? null,
            change_pct: prior > 0 ? Number(((value / prior - 1) * 100).toFixed(2)) : null });
        }
      }
    }
    const selected = candidates.find(row => row.prior_period) ?? candidates[0];
    if (selected) results.push(selected);
  }
  return results;
}

async function secAnalysis(fetcher, env, query) {
  const { data, issuer, annual, source_url } = await secSubmission(fetcher, env, query);
  const facts = annual ? await getJson(fetcher, `${SEC_DATA}api/xbrl/companyfacts/CIK${issuer.code}.json`,
    'sec', env, 20_000_000, raw => selectCompanyFacts(raw, issuer.code)) : {};
  const rows = annual ? annualMetrics(facts, annual) : [];
  return { name: data.name, cik: issuer.code, annual, metrics: rows, source_url };
}

export function createGateway({ fetcher = fetch, clock = () => new Date(), getCache = () => globalThis.caches?.default } = {}) {
  return async function handle(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    const origin = request.headers.get('Origin');
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (origin !== env.ALLOWED_ORIGIN) return Response.json({ status: 'error', code: 'origin_denied' }, { status: 403, headers });
    headers['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'OPTIONS' && routes.has(url.pathname) && request.headers.get('Access-Control-Request-Method') === 'GET') {
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '600' } });
    }
    const provider = url.pathname.startsWith('/v1/dart/') ? 'dart' : 'sec';
    const home = provider === 'dart' ? DART_HOME : SEC_HOME;
    try {
      if (!routes.has(url.pathname)) throw new ApiError(404, 'unknown_route', '지원하지 않는 경로입니다.');
      if (request.method !== 'GET') throw new ApiError(405, 'invalid_method', 'GET만 지원합니다.');
      if (url.search.length > 700) throw invalid('검색어가 너무 깁니다.');
      if (!(await env.CLIENT_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) throw limited();
      const args = filters(url.searchParams, provider, clock());
      const key = new URL(url.pathname, url.origin);
      key.search = new URLSearchParams(Object.entries(args));
      const cache = getCache();
      const hit = await cache?.match(key.href).catch(() => undefined);
      if (hit) return new Response(hit.body, { headers: { ...headers, 'Content-Type': 'application/json', 'X-Disclosure-Cache': 'HIT' } });
      const handler = provider === 'dart' ? dartFilings : url.pathname.endsWith('/analysis') ? secAnalysis : secFilings;
      const deadline = AbortSignal.timeout(20_000);
      const boundedFetch = (target, options) => fetcher(target, { ...options, signal: AbortSignal.any([deadline, options.signal]) });
      const result = { status: 'ok', ...(await handler(boundedFetch, env, args)), checked_at: clock().toISOString() };
      const response = Response.json(result, { headers });
      if (cache) ctx.waitUntil(cache.put(key.href, Response.json(result, { headers: { 'Cache-Control': 'public, max-age=90' } })).catch(() => {}));
      return response;
    } catch (error) {
      const safe = error instanceof ApiError ? error : providerError();
      if (safe.status === 429) headers['Retry-After'] = '60';
      return Response.json({ status: 'error', code: safe.code, message: safe.message, source_url: home, ...safe.details }, { status: safe.status, headers });
    }
  };
}

export default { fetch: createGateway() };
