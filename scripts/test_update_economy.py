import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

p = Path(__file__).with_name('update_economy.py')
spec = importlib.util.spec_from_file_location('update_economy', p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class SnapshotTests(unittest.TestCase):
    def test_failure_preserves_data(self):
        d = {'value':42, 'refresh':{'x':{'last_success':'2026-11-01T00:00:00+00:00','state':'ok'}}}
        def fail():
            raise RuntimeError('provider down')
        self.assertFalse(m.attempt(d,'x',fail,lambda v:d.update(value=v)))
        self.assertEqual(d['value'],42)
        self.assertEqual(d['refresh']['x']['state'],'cached')
        self.assertEqual(d['refresh']['x']['last_success'],'2026-11-01T00:00:00+00:00')

    def test_missing_secret(self):
        d = {'refresh':{}}
        self.assertFalse(m.attempt(d,'x',lambda:self.fail(),lambda v:self.fail(),configured=False))
        self.assertEqual(d['refresh']['x']['state'],'setup')

    def test_forecast_dates(self):
        dates = ['2026-11-23','2026-11-24','2026-11-25','2026-11-27','2026-11-30']
        market = {'origin':'2026-11-20','revision':'abc'}
        payload = {'rows':[{'time':d,'forecast':100.0} for d in dates]}
        self.assertEqual(m.validate_forecast(payload,market,dates)['revision'],'abc')
        payload['rows'][0]['forecast'] = float('nan')
        with self.assertRaises(ValueError):
            m.validate_forecast(payload,market,dates)

    def test_atomic_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'a.json'
            m.atomic_json(p,{'x':1})
            with self.assertRaises(ValueError):
                m.atomic_json(p,{'x':float('nan')})
            with patch.dict('os.environ',{'OPENDART_API_KEY':'fake-secret-for-unit-test'}):
                with self.assertRaises(ValueError):
                    m.atomic_json(p,{'x':'fake-secret-for-unit-test'})
            self.assertEqual(json.loads(p.read_text()),{'x':1})

if __name__ == '__main__':
    unittest.main()
