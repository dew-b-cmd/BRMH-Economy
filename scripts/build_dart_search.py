"""Collect a recent OpenDART public filing snapshot for issuer search on Pages."""

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
import re
from tempfile import TemporaryDirectory

from update_economy import ROOT, now


OUTPUT = ROOT / 'data' / 'dart-recent'
KST = timezone(timedelta(hours=9))
TYPES = 'ABCDEFGHIJ'
SHARDS = 64
PAGE_SIZE = 100


def fetch_type(request, kind):
    first = request(kind, 1)
    if first.get('status') == '013':
        return []
    if first.get('status') != '000':
        raise RuntimeError(f'OpenDART category {kind} returned {first.get("status", "unknown")}')
    pages = int(first['total_page'])
    if not 1 <= pages <= 800:
        raise RuntimeError(f'Unexpected page count for OpenDART category {kind}')
    rows = first['list']
    for page in range(2, pages + 1):
        result = request(kind, page)
        if result.get('status') != '000' or int(result.get('page_no', 0)) != page:
            raise RuntimeError(f'OpenDART category {kind}, page {page} unavailable')
        rows.extend(result['list'])
    return rows


def collect(request, begin, end):
    with ThreadPoolExecutor(max_workers=4) as executor:
        by_type = list(executor.map(lambda kind: fetch_type(request, kind), TYPES))
    filings = defaultdict(dict)
    for kind, rows in zip(TYPES, by_type):
        for row in rows:
            code, receipt, received, name = (row.get(key, '') for key in
                                              ('corp_code', 'rcept_no', 'rcept_dt', 'report_nm'))
            if (re.fullmatch(r'[0-9]{8}', code) and re.fullmatch(r'[0-9]{14}', receipt)
                    and re.fullmatch(r'[0-9]{8}', received) and begin <= received <= end and name):
                filing = filings[code].setdefault(receipt, [received, receipt, name, ''])
                if kind not in filing[3]:
                    filing[3] += kind
    return {code: sorted(items.values(), reverse=True) for code, items in filings.items()}


def publish(filings, begin, end):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    buckets = [{} for _ in range(SHARDS)]
    for code, rows in filings.items():
        shard = sha256(code.encode()).digest()[0] % SHARDS
        buckets[shard][code] = rows
    with TemporaryDirectory(dir=OUTPUT.parent) as tmp:
        stage = OUTPUT.parent / os.path.basename(tmp)
        for index, bucket in enumerate(buckets):
            write(stage / f'{index:02x}.json', bucket)
        for source in stage.iterdir():
            os.replace(source, OUTPUT / source.name)
        write(stage / 'status.json', {
            'checked_at': now(), 'start': begin, 'end': end,
            'issuers': len(filings), 'filings': sum(map(len, filings.values())),
        })
        os.replace(stage / 'status.json', OUTPUT / 'status.json')


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n',
                    encoding='utf-8', newline='\n')


def main():
    import briefing_server as api
    key = api.read_settings()['OPENDART_API_KEY']
    today = datetime.now(KST).date()
    start = (today - timedelta(days=29)).strftime('%Y%m%d')
    end = today.strftime('%Y%m%d')

    def request(kind, page):
        raw = api.request_bytes(api.DART_URL, {
            'crtfc_key': key, 'bgn_de': start, 'end_de': end, 'pblntf_ty': kind,
            'page_no': page, 'page_count': PAGE_SIZE, 'sort': 'date', 'sort_mth': 'desc',
        }, timeout=15)
        return json.loads(raw)

    try:
        filings = collect(request, start, end)
        if len(filings) < 100:
            raise RuntimeError('Incomplete OpenDART 30-day snapshot')
        publish(filings, start, end)
    except Exception as exc:
        status = OUTPUT / 'status.json'
        if not status.is_file() or not all((OUTPUT / f'{i:02x}.json').is_file() for i in range(SHARDS)):
            raise RuntimeError(f'OpenDART first snapshot unavailable ({type(exc).__name__})') from None
        print(f'OpenDART snapshot retained ({type(exc).__name__})')
        return
    print(f'OpenDART snapshot: {sum(map(len, filings.values()))} filings across {len(filings)} companies')


if __name__ == '__main__':
    main()
