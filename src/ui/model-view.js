// The calibration view: a chart and table of the bike's resistance model.

import { powerFor } from '../core/resistance.js';
import { levelCounts, totalReadings } from '../core/learn.js';
import { calibration, activeModel, learner } from './store.js';
import { $ } from './dom.js';
import { round1 } from './format.js';
import { esc, modelSvg, modelRange, MODEL_PLOT, MODEL_CADENCES } from './charts.js';
import { calib } from './calibration.js';

function renderModel() {
  const model = activeModel();
  const { lo, hi, from, to } = modelRange(model);
  const counts = levelCounts(learner.bins);
  const readings = totalReadings(learner.bins);
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const about = model.calibrated
    ? [calibration?.bike, calibration?.date && `calibrated ${day(calibration.date)}`, calibration?.updated && `last updated ${day(calibration.updated)}`].filter(Boolean).map(esc).join(' · ')
    : 'Not calibrated yet. This is the generic curve the app uses until you calibrate.';

  // One row per measured level while there are only a few, then every five levels.
  const few = model.knots && model.knots.length <= 12;
  const levels = few ? model.knots.map(([r]) => r) : [];
  if (!few) for (let r = Math.ceil(lo / 5) * 5; r <= hi; r += 5) levels.push(r);
  const near = (r) => (few ? counts[r] ?? 0 : [-2, -1, 0, 1, 2].reduce((n, d) => n + (counts[r + d] ?? 0), 0));
  const rows = levels.map((r) => `<tr class="${r < from || r > to ? 'est' : ''}"><td>${r}</td>${MODEL_CADENCES.map(({ rpm }) => `<td>${Math.round(powerFor(model, r, rpm))} W</td>`).join('')}<td>${model.knots ? near(r) : '–'}</td></tr>`).join('');

  const cv = calibration?.check;
  $('model-body').innerHTML = `
    <p class="muted small">${about}</p>
    <div class="model-chart">
      <div class="model-legend">
        <span>Watts at each resistance</span>
        <span class="legend">${MODEL_CADENCES.map(({ rpm, color }) => `<span><i class="sw" style="background:${color}"></i>${rpm} rpm</span>`).join('')}</span>
      </div>
      ${modelSvg(model)}
      <div id="model-tip" class="model-tip" hidden></div>
    </div>
    <div class="model-facts">
      <div class="stat"><span class="stat-num">${model.knots ? `${from}–${to}` : '–'}</span><span class="stat-label">Levels measured</span></div>
      <div class="stat"><span class="stat-num">+${Math.round((1.1 ** model.b - 1) * 100)}%</span><span class="stat-label">Watts for 10% more cadence</span></div>
      <div class="stat"><span class="stat-num">${cv ? `±${round1(Math.max(0.5, cv.interiorMeanAbs))}` : '–'}</span><span class="stat-label">Resistance margin of error</span></div>
    </div>
    <div>
      <table class="calib-table"><thead><tr><th>Resistance</th>${MODEL_CADENCES.map(({ rpm }) => `<th>${rpm} rpm</th>`).join('')}<th>Readings</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <p class="muted small">${model.knots
      ? `Built from ${readings} readings. Dashed lines and grey rows are beyond the levels measured so far. If the bike reports its resistance, the model is updated after every ride.`
      : 'Calibrate to replace this with measurements from your bike.'}</p>`;
  $('model-calibrate').textContent = model.calibrated ? 'Calibrate again' : 'Calibrate';

  // Hover: a crosshair and the watts at that resistance for each cadence.
  const svg = $('model-svg');
  const cross = $('model-cross');
  const tip = $('model-tip');
  const { width, left, right } = MODEL_PLOT;
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const r = Math.round(Math.min(hi, Math.max(lo, lo + ((px - left) / (width - left - right)) * (hi - lo))));
    const x = left + ((r - lo) / (hi - lo)) * (width - left - right);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `Resistance ${r}<br>${[...MODEL_CADENCES].reverse().map(({ rpm, color }) => `<i style="background:${color}"></i>${rpm} rpm · ${Math.round(powerFor(model, r, rpm))} W`).join('<br>')}`;
    tip.hidden = false;
    const frac = x / width;
    tip.style.left = frac < 0.55 ? `calc(${frac * 100}% + 18px)` : 'auto';
    tip.style.right = frac < 0.55 ? 'auto' : `calc(${(1 - frac) * 100}% + 18px)`;
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

$('btn-model').addEventListener('click', () => {
  renderModel();
  $('model-dialog').showModal();
});
$('model-close').addEventListener('click', () => $('model-dialog').close());
$('model-calibrate').addEventListener('click', () => {
  $('model-dialog').close();
  calib.start();
});
