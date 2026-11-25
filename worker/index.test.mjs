import assert from 'node:assert/strict';
import test from 'node:test';
import { annualMetrics, createGateway, dartNameKey, selectCompanyFacts } from './index.mjs';

const origin = 'https://dew-b-cmd.github.io';
const ok = () => ({ success: true });
const env = { ALLOWED_ORIGIN: origin, CATALOG_BASE: `${origin}/catalog/`, OPENDART_API_KEY: 'test-only-credential',
  SEC_CONTACT_EMAIL: 'test@example.invalid', CLIENT_LIMIT: { limit: ok }, PROVIDER_LIMIT: { limit: ok } };
const now = () => new Date('2026-11-25T14:00:00Z');
const issuer = ['00126380', '삼성전자', '005930'];
const fakeCatalog = { 'n:삼성전자': [issuer], 's:005930': [issuer], 'c:00126380': [issuer], 't:LUNR': [['0001844452','Intuitive Machines','LUNR']] };
const accession = '0001844452-26-000001';
const rows = {
  form: ['8-K', '10-Q', '10-Q/A'],
  filingDate: ['2026-11-19','2026-11-11','2026-10-22'],
  accessionNumber: ['0001844452-26-000003','0001844452-26-000002',accession],
  primaryDocument: ['sample.htm','sample.htm','sample.htm'],
};

function gateway(upstream, overrides = {}) {
  const handle = createGateway({ clock: now, fetcher: (url, options) => {
    if (new URL(url).pathname.startsWith('/catalog/')) return Response.json(fakeCatalog);
    return upstream(new URL(url), options);
  }});
  return (path, requestOrigin = origin) => handle(new Request('https://gateway.example' + path, { headers: { Origin: requestOrigin } }),
    { ...env, ...overrides }, { waitUntil() {} });
}

test('validates dates, input codes, origin and rate limit before provider calls', async () => {
  const call = gateway(() => assert.fail('Unexpected provider request'));
  assert.equal((await call('/v1/sec/filings?q=LUNR', 'https://other.example')).status, 403);
  assert.equal((await call('/v1/dart/filings?q=12345')).status, 400);
  assert.equal((await call('/v1/sec/filings?q=LUNR&start=2026-02-30')).status, 400);
  assert.equal((await call('/v1/sec/filings?q=NOT-A-TICKER')).status, 404);
  assert.equal((await gateway(() => assert.fail(), { CLIENT_LIMIT: { limit: () => ({ success: false }) } })('/v1/sec/filings?q=LUNR')).status, 429);
});

test('DART name, ticker and issuer number resolve to the same code', async () => {
  const call = gateway(url => {
    assert.equal(url.hostname, 'opendart.fss.or.kr');
    assert.equal(url.searchParams.get('corp_code'), '00126380');
    assert.equal(url.searchParams.get('pblntf_ty'), 'A');
    assert.equal(url.searchParams.get('page_no'), '2');
    return Response.json({ status: '013' });
  });
  for (const q of ['삼성 전자','005930','00126380']) {
    const response = await call(`/v1/dart/filings?q=${encodeURIComponent(q)}&type=A&page=2`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, []);
  }
  assert.equal(dartNameKey('삼성전자 주식회사'), '삼성전자');
});

test('SEC filters, sorts, includes amended filings and paginates within the same issuer', async () => {
  const call = gateway(url => {
    assert.equal(url.pathname, '/submissions/CIK0001844452.json');
    return Response.json({ cik: '1844452', name: 'Intuitive Machines', filings: { recent: rows, files: [] } });
  });
  const response = await call('/v1/sec/filings?q=LUNR&type=10-Q&page_size=1&page=2');
  const data = await response.json();
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(data.cik, '0001844452');
  assert.equal(data.total, 2);
  assert.equal(data.total_pages, 2);
  assert.equal(data.items[0].form, '10-Q/A');
  assert.match(data.items[0].url, /^https:\/\/www\.sec\.gov\//);
});

test('authentication, provider outage and timeout never disclose the upstream credential', async () => {
  for (const [upstream, status, code] of [
    [() => Response.json({ status: '010', message: env.OPENDART_API_KEY }), 502, 'source_auth_error'],
    [() => new Response('Unavailable', { status: 503 }), 502, 'source_unavailable'],
    [() => { throw new DOMException(env.OPENDART_API_KEY, 'TimeoutError'); }, 504, 'source_timeout'],
  ]) {
    const response = await gateway(upstream)('/v1/dart/filings?q=00126380');
    assert.equal(response.status, status);
    const raw = await response.text();
    assert.equal(raw.includes(env.OPENDART_API_KEY), false);
    assert.equal(JSON.parse(raw).code, code);
  }
});

test('annual financial facts compare only full years in the same SEC accession', () => {
  const facts = { 'us-gaap': { NetIncomeLoss: { units: { USD: [
    { accn: accession, start: '2025-01-01', end: '2025-12-31', val: 15 },
    { accn: accession, start: '2024-01-01', end: '2024-12-31', val: 10 },
    { accn: accession, start: '2025-10-01', end: '2025-12-31', val: 4 },
    { accn: 'other', start: '2025-01-01', end: '2025-12-31', val: 90 },
  ] } } } };
  const [result] = annualMetrics(facts, { accession, period: '2025-12-31' });
  assert.equal(result.value, 15);
  assert.equal(result.prior_value, 10);
  assert.equal(result.change_pct, 50);
});

test('selects the same SEC facts from compact and formatted responses', () => {
  const concept = { label: 'Example", here', units: { USD: [{ val: 1 }], EUR: [{ val: 2 }] } };
  const data = { cik: 1844452, entityName: 'Intuitive Machines', facts: {
    dei: { EntityCommonStockSharesOutstanding: concept },
    'us-gaap': { Assets: concept, NetIncomeLoss: concept },
    'ifrs-full': { ProfitLoss: concept },
  } };
  const compact = selectCompanyFacts(JSON.stringify(data), '0001844452');
  assert.deepEqual(compact, { 'us-gaap': { NetIncomeLoss: concept }, 'ifrs-full': { ProfitLoss: concept } });
  assert.deepEqual(selectCompanyFacts(JSON.stringify(data, null, 2), '0001844452'), data.facts);
  assert.throws(() => selectCompanyFacts(JSON.stringify(data), 42));
});
