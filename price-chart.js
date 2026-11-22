'use strict';

function drawPriceChart(chart, rows, baseline) {
  const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
  const svg = (tag, attributes, label = '') => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (label) element.textContent = label;
    return element;
  };
  chart.replaceChildren();
  const values = [baseline, ...rows.flatMap(row => [row.actual, row.forecast])].filter(Number.isFinite);
  if (rows.length < 2 || !values.length) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = index => 90 + index * 885 / (rows.length - 1);
  const y = value => 252 - (value - min) * 218 / range;
  for (let index = 0; index <= 4; index++) {
    const value = min + range * index / 4;
    chart.append(
      svg('line', { x1: 90, x2: 975, y1: y(value), y2: y(value), stroke: '#dce6e1' }),
      svg('text', { x: 80, y: y(value) + 4, 'text-anchor': 'end', fill: '#53676a', 'font-size': 13 }, number.format(value))
    );
  }
  if (Number.isFinite(baseline)) {
    chart.append(svg('line', { x1: 90, x2: 975, y1: y(baseline), y2: y(baseline),
      stroke: '#a45624', 'stroke-dasharray': '8 5', 'stroke-width': 2 }));
  }
  for (const [key, color] of [['actual', '#182e40'], ['forecast', '#007768']]) {
    const points = rows.flatMap((row, index) => Number.isFinite(row[key]) ? [x(index) + ',' + y(row[key])] : []);
    if (points.length) {
      chart.append(svg('polyline', { class: key + '-series', points: points.join(' '), fill: 'none', stroke: color, 'stroke-width': 2.6 }));
    }
  }
  const dateLabel = row => row.time.replace('T', ' ').slice(0, 16);
  chart.append(
    svg('text', { x: 90, y: 280, fill: '#53676a', 'font-size': 13 }, dateLabel(rows[0])),
    svg('text', { x: 975, y: 280, 'text-anchor': 'end', fill: '#53676a', 'font-size': 13 }, dateLabel(rows.at(-1)))
  );
}
