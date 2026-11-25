"""Publish small, public issuer lookup shards from SEC and OpenDART directories."""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unicodedata
from xml.etree import ElementTree
from zipfile import ZipFile

from update_economy import ROOT, now


CATALOG = ROOT / 'data' / 'disclosure-catalog'
SHARD_COUNT = 64
DART_CORPS = 'https://opendart.fss.or.kr/api/corpCode.xml'


def name_key(value):
    compact = re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).lower()
    return re.sub(r'주식회사|㈜|\(주\)', '', compact)


def dart_issuers(archive):
    with ZipFile(BytesIO(archive)) as zipped:
        entry = zipped.getinfo('CORPCODE.xml')
        if entry.file_size > 80 * 1024 * 1024:
            raise ValueError('Corporate directory exceeds size limit')
        with zipped.open(entry) as xml:
            for _, row in ElementTree.iterparse(xml, events=('end',)):
                if row.tag != 'list':
                    continue
                code = (row.findtext('corp_code') or '').strip()
                stock = (row.findtext('stock_code') or '').strip()
                name = (row.findtext('corp_name') or '').strip()
                if re.fullmatch(r'[0-9]{8}', code) and name:
                    stock = stock if re.fullmatch(r'[0-9]{6}', stock) else ''
                    issuer = [code, name, stock]
                    yield 'c:' + code, issuer
                    if stock:
                        yield 's:' + stock, issuer
                    if key := name_key(name):
                        yield 'n:' + key, issuer
                row.clear()


def sec_issuers(tickers):
    for row in tickers.values():
        symbol = row['ticker'].strip().upper().replace('.', '-')
        cik = row['cik_str']
        if re.fullmatch(r'[A-Z][A-Z0-9-]{0,14}', symbol) and isinstance(cik, int) and 0 < cik < 10**10:
            yield 't:' + symbol, [f'{cik:010d}', row['title'], symbol]


def publish(provider, entries, output):
    buckets = [defaultdict(set) for _ in range(SHARD_COUNT)]
    count = 0
    for key, value in entries:
        shard = sha256(key.encode('utf-8')).digest()[0] % SHARD_COUNT
        buckets[shard][key].add(tuple(value))
        count += 1
    if count < 1_000:
        raise ValueError('Incomplete issuer directory')
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as tmp:
        stage = Path(tmp)
        for shard, bucket in enumerate(buckets):
            encoded = json.dumps({key: sorted(rows) for key, rows in bucket.items()},
                                 sort_keys=True, ensure_ascii=False, separators=(',', ':'))
            (stage / f'{provider}-{shard:02x}.json').write_text(encoded + '\n', encoding='utf-8', newline='\n')
        for path in stage.iterdir():
            os.replace(path, output / path.name)
    return count


def refresh(provider, load):
    marker = CATALOG / f'{provider}-updated.json'
    existing = marker.is_file() and all((CATALOG / f'{provider}-{i:02x}.json').is_file() for i in range(SHARD_COUNT))
    if existing:
        stamp = json.loads(marker.read_text(encoding='utf-8'))['updated_at']
        if datetime.now(timezone.utc) - datetime.fromisoformat(stamp) < timedelta(hours=22):
            print(f'{provider}: issuer directory current')
            return
    try:
        count = publish(provider, load(), CATALOG)
    except Exception as exc:
        if not existing:
            raise RuntimeError(f'{provider} issuer directory unavailable: {type(exc).__name__}') from None
        print(f'{provider}: retaining previous directory ({type(exc).__name__})')
        return
    marker.write_text(json.dumps({'updated_at': now(), 'mapping_entries': count}) + '\n',
                      encoding='utf-8', newline='\n')
    print(f'{provider}: published {count} issuer mappings')


def main():
    import briefing_server as api
    settings = api.read_settings()
    refresh('dart', lambda: dart_issuers(api.request_bytes(
        DART_CORPS, {'crtfc_key': settings['OPENDART_API_KEY']}, limit=16 * 1024 * 1024, timeout=25)))
    refresh('sec', lambda: sec_issuers(api.sec_json(api.SEC_TICKERS_URL, settings['SEC_CONTACT_EMAIL'])))


if __name__ == '__main__':
    main()
