"""Publish recent SEC index records by CIK as a fallback for EDGAR filing search."""

from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import os
import re

from build_dart_search import write
from update_economy import ROOT, now


OUTPUT = ROOT / 'data' / 'sec-recent'
SHARDS = 64
FILENAME = re.compile(r'edgar/data/[0-9]+/[0-9]{10}-[0-9]{2}-[0-9]{6}\.txt')


def quarter(day):
    return day.year, (day.month - 1) // 3 + 1


def records(raw):
    body = raw.decode('utf-8', errors='replace')
    heading = 'CIK|Company Name|Form Type|Date Filed|Filename'
    if heading not in body:
        raise ValueError('Missing EDGAR index header')
    for line in body.partition(heading)[2].splitlines():
        columns = line.rsplit('|', 3)
        if len(columns) != 4:
            continue
        company, form, filed, filename = columns
        cik, separator, name = company.partition('|')
        if (separator and name and form and re.fullmatch(r'[0-9]{1,10}', cik)
                and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', filed)
                and FILENAME.fullmatch(filename)):
            yield cik.zfill(10), name, form, filed, filename


def collect(read_index, today):
    earliest = (today - timedelta(days=94)).isoformat()
    records_by_cik = {}
    end = ''
    for year, number in sorted({quarter(today), quarter(today - timedelta(days=94)), quarter(today - timedelta(days=47))}):
        data = read_index(year, number)
        for cik, name, form, filed, filename in records(data):
            if not earliest <= filed <= today.isoformat():
                continue
            end = max(end, filed)
            records_by_cik.setdefault(cik, {})[filename] = [filed, form, filename, name]
    if len(records_by_cik) < 1000 or not end:
        raise ValueError('Incomplete SEC index directory')
    start = (datetime.fromisoformat(end).date() - timedelta(days=89)).isoformat()
    keep = {}
    for cik, filings in records_by_cik.items():
        recent = sorted((item for item in filings.values() if item[0] >= start), reverse=True)
        if recent:
            keep[cik] = [recent[0][3], [item[:3] for item in recent]]
    return keep, start, end


def publish(issuers, start, end):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    buckets = [{} for _ in range(SHARDS)]
    for cik, value in issuers.items():
        shard = sha256(cik.encode()).digest()[0] % SHARDS
        buckets[shard][cik] = value
    status = {'checked_at': now(), 'start': start, 'end': end, 'issuers': len(issuers),
              'filings': sum(len(value[1]) for value in issuers.values())}
    with TemporaryDirectory(dir=OUTPUT.parent) as tmp:
        stage = Path(tmp)
        for index, bucket in enumerate(buckets):
            write(stage / f'{index:02x}.json', bucket)
        for path in stage.iterdir():
            os.replace(path, OUTPUT / path.name)
        write(stage / 'status.json', status)
        os.replace(stage / 'status.json', OUTPUT / 'status.json')
    print(f'SEC index: {status["filings"]} filings across {status["issuers"]} filers, through {end}')


def main():
    import briefing_server as api
    contact = api.read_settings()['SEC_CONTACT_EMAIL']

    def request(year, number):
        return api.request_bytes(f'https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{number}/master.idx',
                                 {}, headers={'User-Agent': f'BRMH Economy {contact}'},
                                 limit=32 * 1024 * 1024, timeout=45)

    try:
        publish(*collect(request, datetime.now(timezone.utc).date()))
    except Exception as exc:
        existing = (OUTPUT / 'status.json').is_file() and all((OUTPUT / f'{i:02x}.json').is_file() for i in range(SHARDS))
        if not existing:
            raise RuntimeError(f'SEC first index unavailable ({type(exc).__name__})') from None
        print(f'SEC index retained ({type(exc).__name__})')


if __name__ == '__main__':
    main()
