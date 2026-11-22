'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const button = byId('nvda-refresh');
  const status = byId('nvda-status');
  const dollars = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'USD' });
  const percent = new Intl.NumberFormat('ko-KR', { style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 2 });
  const checkedTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' });
  let market;
  let forecast;

  function render() {
    if (!market) return;
    byId('nvda-market').hidden = false;
    byId('nvda-close').textContent = dollars.format(market.close);
    byId('nvda-change').textContent = '전 거래일 대비 ' + percent.format(market.change_percent / 100);
    byId('nvda-origin').textContent = market.origin + ' 미국 정규장 마감';
    byId('nvda-checked').textContent = '조회 ' + checkedTime.format(new Date(market.checked_at)) + ' (한국 시간)';
    byId('nvda-source').href = market.source;

    const rows = market.history.map(row => ({ ...row }));
    if (forecast) {
      rows.at(-1).forecast = market.close;
      rows.push(...forecast.rows);
    }
    drawPriceChart(byId('nvda-chart'), rows);
    byId('nvda-legend').hidden = !forecast;
    byId('nvda-forecast').hidden = !forecast;
    byId('nvda-dates').replaceChildren(...(forecast?.rows || []).map(row => {
      const item = document.createElement('div');
      const day = document.createElement('dt');
      const value = document.createElement('dd');
      day.textContent = row.time;
      value.textContent = dollars.format(row.forecast);
      item.append(day, value);
      return item;
    }));
  }

  async function request(path, method, timeout) {
    const response = await window.kronosPagesRequest('./api/nvda/' + path, { method, signal: AbortSignal.timeout(timeout) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'NVDA 자료를 불러오지 못했습니다.');
    return data;
  }

  async function refresh() {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'Nasdaq 마감 종가를 조회하고 있습니다…';
    try {
      market = await request('daily', 'GET', 15000);
      if (forecast?.revision !== market.revision) forecast = null;
      render();
      if (market.forecast_message) {
        status.textContent = market.forecast_message;
        return;
      }
      if (!forecast) {
        status.textContent = 'Kronos가 다음 5거래일을 계산하고 있습니다…';
        forecast = await request('forecast', 'POST', 110000);
        if (forecast.revision !== market.revision) {
          throw new Error('새 종가가 반영됐습니다. 가격을 다시 조회하세요.');
        }
        render();
      }
      status.textContent = '수집된 마지막 정규장 종가 기준의 Kronos 결과입니다.';
    } catch (error) {
      forecast = null;
      render();
      status.textContent = error.name === 'TimeoutError' ? '응답이 지연되고 있습니다. 잠시 후 다시 조회하세요.' : error.message;
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener('click', refresh);
  refresh();
})();
