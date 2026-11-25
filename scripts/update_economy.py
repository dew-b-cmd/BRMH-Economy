"""Collect public snapshots using the original archived Kronos backend."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from datetime import datetime, timezone, date
from time import monotonic

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.runtime' / 'kronos-economy'
SNAPSHOT = ROOT / 'data' / 'economy.json'
sys.path.insert(0, str(SOURCE))


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def atomic_json(path, data):
    encoded = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    for key in ('CUSTOMS_SERVICE_KEY', 'OPENDART_API_KEY', 'SEC_CONTACT_EMAIL'):
        secret = os.environ.get(key, '')
        if len(secret) >= 6 and secret in encoded:
            raise ValueError('Secret detected in snapshot')
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        f.write(encoded)
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def require(condition):
    if not condition:
        raise ValueError('Invalid or incomplete source data')


def attempt(data, name, load, save, *, configured=True, interval=0, force=False):
    meta = data.setdefault('refresh', {}).setdefault(name, {})
    stamp = now()
    if configured and not force and interval and meta.get('state') == 'ok' and meta.get('last_success'):
        elapsed = (datetime.fromisoformat(stamp) - datetime.fromisoformat(meta['last_success'])).total_seconds()
        if elapsed < interval:
            return True
    meta['last_attempt'] = stamp
    if not configured:
        meta['state'] = 'setup'
    else:
        try:
            value = load()
            require(value is not None)
            json.dumps(value, allow_nan=False)
            save(value)
        except Exception as exc:
            meta['state'] = 'cached' if meta.get('last_success') or meta.get('state') in ('baseline', 'cached', 'setup') else 'error'
            print(f'{name}: {meta["state"]} ({type(exc).__name__})')
            return False
        else:
            meta.update(state='ok', last_success=stamp)
    print(f'{name}: {meta["state"]}')
    return meta['state'] == 'ok'


def validate_forecast(value, market, future):
    rows = value['rows']
    require(len(rows) == 5 and [r['time'] for r in rows] == list(future))
    require(all(math.isfinite(r['forecast']) and r['forecast'] > 0 for r in rows))
    require(all(r['time'] > market['origin'] for r in rows))
    return {'rows': rows, 'origin': market['origin'], 'revision': market['revision'],
            'model': 'NeoQuasar/Kronos-small', 'model_revision': '901c26c1332695a2a8f243eb2f37243a37bea320'}


def collect(data, force=False):
    import briefing_server as api
    import market_reports
    from nvda_live import is_trading_day
    settings = api.read_settings()
    today = datetime.now(api.KST).date()
    bucket = int(monotonic())

    def source(name, load, save, configured=True, interval=0, override=False):
        return attempt(data, name, load, save, configured=configured, interval=interval, force=force or override)

    def exports(code, label):
        value = api.export_summary(settings['CUSTOMS_SERVICE_KEY'], today, code, label)
        require(value['status'] == 'ok' and value['value_usd'] >= 0)
        previous = next((r for r in data['exports'] if r['hs_code'] == code), {})
        require(value['month'] >= previous.get('month', ''))
        return value

    def save_export(value):
        data['exports'] = [value if r['hs_code'] == value['hs_code'] else r for r in data['exports']]
        if value['hs_code'] == '8542':
            data['industry']['exports'] = value

    for code, label in api.PRODUCTS:
        source('exports:' + code, lambda: exports(code, label), save_export,
               bool(settings['CUSTOMS_SERVICE_KEY']), 20 * 3600)

    def dart():
        value = api.fetch_disclosures(settings['OPENDART_API_KEY'], today, '', bucket)
        require(isinstance(value['items'], list) and value['end'] >= data['dart']['end'])
        return value
    source('dart', dart, lambda v: data.update(dart=v), bool(settings['OPENDART_API_KEY']))

    for symbol, cik in (('NVDA', '0001045810'), ('AAPL', '0000320193')):
        def filings():
            value = api.fetch_sec_filings(settings['SEC_CONTACT_EMAIL'], cik, bucket)
            require(value['cik'] == cik and bool(value['items']))
            old = data['sec'][symbol]['items']
            require(not old or value['items'][0]['filed'] >= old[0]['filed'])
            return value
        ok = source('sec:' + symbol, filings, lambda v: data['sec'].update({symbol:v}), bool(settings['SEC_CONTACT_EMAIL']))

        def analysis():
            payload = data['sec'][symbol]
            annual = payload['annual']
            require(bool(annual))
            metrics = api.fetch_annual_metrics(settings['SEC_CONTACT_EMAIL'], cik, annual['accession'], annual['period'], bucket)
            require(bool(metrics))
            return {'name': payload['name'], 'annual': annual, 'metrics': metrics}

        def save_analysis(value):
            data['analysis'][symbol] = value
            if symbol == 'NVDA':
                data['filing'] = value
        changed = data['sec'][symbol].get('annual') != data['analysis'][symbol].get('annual')
        if ok:
            source('analysis:' + symbol, analysis, save_analysis, True, 20 * 3600, override=changed)
        else:
            meta = data['refresh']['analysis:' + symbol]
            meta.update(state='setup' if not settings['SEC_CONTACT_EMAIL'] else 'cached', last_attempt=now())

    def production():
        value = api.research_production(today)
        require(value['month'] >= (data['industry'].get('production') or {}).get('month', ''))
        require(math.isfinite(value['value']) and value['value'] > 0)
        return value

    def save_production(value):
        data['industry']['production'] = value
        data['industry'].pop('production_error', None)
    source('production', production, save_production, interval=20 * 3600)

    def sector():
        value = api.research_sector(today)
        require(bool(value['periods']))
        require(value['periods'][0]['end'] >= data['sector']['periods'][0]['end'])
        return value
    source('sector', sector, lambda v: data.update(sector=v), interval=20 * 3600)

    inputs = {}
    def market():
        value, normalized, future = api.nvda_market()
        require(value['origin'] >= data['market']['origin'])
        require(all(is_trading_day(date.fromisoformat(r['time'])) for r in value['history']))
        require(math.isfinite(value['close']) and value['close'] > 0)
        require(bool(normalized) and bool(value['revision']) and not value['forecast_message'])
        inputs.update(normalized=normalized, future=future)
        return value
    ok = source('market', market, lambda v: data.update(market=v))
    if ok:
        market_value = data['market']
        old = data.get('forecast', {})
        if old.get('revision') != market_value['revision'] or force or data['refresh']['forecast']['state'] != 'ok':
            def predict():
                models = SOURCE / '.research-cache' / 'models'
                if not all((models / folder / file).is_file() for folder in ('tokenizer','predictor') for file in ('config.json','model.safetensors')):
                    subprocess.run([sys.executable, str(SOURCE / 'prepare_research_model.py')], cwd=SOURCE, check=True, timeout=600)
                return validate_forecast(api.predict_nvda(inputs['normalized'], inputs['future']), market_value, inputs['future'])
            source('forecast', predict, lambda v: data.update(forecast=v))
    else:
        data['refresh']['forecast'].update(state='pending', last_attempt=now())

    market_reports.DATA = ROOT / 'data.js'
    try:
        for label, status, count in market_reports.refresh():
            print(f'RSS {label}: {status} ({count})')
    except Exception as exc:
        print('RSS: ' + type(exc).__name__)
    data['checked'] = now()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    data = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    collect(data, args.force)
    atomic_json(SNAPSHOT, data)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write('## Source refresh results\n\n|Source|State|Last success (UTC)|\n|---|---|---|\n')
            for name, row in data['refresh'].items():
                f.write(f'|{name}|{row["state"]}|{row.get("last_success") or "—"}|\n')

if __name__ == '__main__':
    main()
