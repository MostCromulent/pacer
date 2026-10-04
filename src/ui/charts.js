// Small SVG builders for the setup preview, the route strip and the summary.
// All inputs are numbers or text we generate ourselves; text is escaped anyway.

import { zoneOf } from '../core/workout.js';
import { powerFor } from '../core/resistance.js';
import { ZONE_COLORS, P } from './palette.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Workout preview: one rounded block per step, height by intensity, colour by zone.
 * `effort` scales every step, so the blocks grow and change zone with the effort setting.
 * Each step also has an unseen full-height strip, so a short block is as easy to tap as a tall one.
 */
export function profileSvg(workout, width, height, effort = 1) {
  const total = workout.totalS;
  const gap = 2;
  let x = 0;
  const rects = workout.segments.map((s, i) => {
    const w = Math.max(1, (s.dur / total) * width - gap);
    const pct = s.pct * effort;
    const h = Math.round(14 + (Math.min(pct, 150) / 150) * (height - 20));
    const r = `<rect class="step-bar" data-seg="${i}" x="${x.toFixed(1)}" y="${height - h}" width="${w.toFixed(1)}" height="${h}" rx="${Math.min(6, w / 2).toFixed(1)}" fill="${ZONE_COLORS[zoneOf(pct)]}"/>`
      + `<rect data-seg="${i}" x="${x.toFixed(1)}" y="0" width="${((s.dur / total) * width).toFixed(1)}" height="${height}" fill="transparent"/>`;
    x += (s.dur / total) * width;
    return r;
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

const byPower = (s) => Math.min(s.pct, 150) / 150;

/**
 * Route strip for the mini window: the workout as paper blocks, gate flags and a playhead.
 * `heightOf(segment)` gives each block's height from 0 to 1.
 */
export function routeSvg(workout, width = 328, height = 56, heightOf = byPower) {
  const total = workout.totalS;
  let d = `M0,${height}`;
  for (const s of workout.segments) {
    const x0 = (s.start / total) * width;
    const x1 = ((s.start + s.dur) / total) * width;
    const y = (height - (6 + clamp01(heightOf(s)) * (height - 12))).toFixed(1);
    const r = Math.min(3, (x1 - x0) / 4);
    d += ` L${(x0 + r).toFixed(1)},${y} L${(x1 - r).toFixed(1)},${y}`;
  }
  d += ` L${width},${height} Z`;
  const flags = workout.gates
    .map((g) => {
      const x = ((g.start / total) * width).toFixed(1);
      return `M${x},${height} V3 l8,3.5 l-8,3.5 Z`;
    })
    .join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" aria-hidden="true">
    <defs><clipPath id="route-past"><rect id="route-past-rect" x="0" y="0" width="0" height="${height}"/></clipPath></defs>
    <path d="${d}" fill="${P.track}"/>
    <path d="${d}" fill="${P.hill}" clip-path="url(#route-past)"/>
    <path d="${flags}" fill="${P.coral}" stroke="${P.coral}" stroke-width="2" stroke-linejoin="round"/>
    <circle id="route-dot" cx="0" cy="${height - 8}" r="6" fill="${P.coral}" stroke="#fff" stroke-width="3"/>
  </svg>`;
}

/** Move the route strip's playhead. */
export function updateRoute(root, workout, t, width = 328, height = 56, heightOf = byPower) {
  const x = Math.max(0, Math.min(width, (t / workout.totalS) * width));
  const rect = root.querySelector('#route-past-rect');
  const dot = root.querySelector('#route-dot');
  if (!rect || !dot) return;
  rect.setAttribute('width', x.toFixed(1));
  let si = workout.segments.findIndex((s) => t < s.start + s.dur);
  if (si < 0) si = workout.segments.length - 1;
  dot.setAttribute('cx', x.toFixed(1));
  dot.setAttribute('cy', (height - (6 + clamp01(heightOf(workout.segments[si])) * (height - 12))).toFixed(1));
}

// The ride chart on the summary: cadence and resistance as lines in the top
// panel, power as a filled area in the bottom one. The geometry is shared with
// the hover readout in summary.js.
export const RIDE_PLOT = { width: 1040, height: 452, left: 44, right: 915, top: 46, split: 222, powerTop: 283, base: 384 };
export const RIDE_COLORS = { cadence: '#12898B', resistance: '#6A55B8', watts: '#EFA58E', wattsText: '#B9705C', miss: '#F2B13C' };

/** A running average over `half` seconds either side. */
function smoothed(values, half) {
  return values.map((_, i) => {
    const from = Math.max(0, i - half), to = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += values[j];
    return sum / (to - from + 1);
  });
}

/** The scales of a ride chart: x for a second, y for cadence and resistance, y for watts. */
export function rideScales(review) {
  const { left, right, top, split, powerTop, base } = RIDE_PLOT;
  const levelMax = Math.max(110, Math.ceil((Math.max(0, ...review.cadence) + 5) / 20) * 20);
  const wattsMax = Math.max(200, Math.ceil((Math.max(0, ...smoothed(review.watts, 5)) + 1) / 100) * 100);
  return {
    levelMax,
    wattsMax,
    x: (sec) => left + (sec / Math.max(1, review.seconds)) * (right - left),
    yLevel: (v) => split - (Math.min(v, levelMax) / levelMax) * (split - top),
    yWatts: (v) => base - (Math.min(v, wattsMax) / wattsMax) * (base - powerTop),
  };
}

/** @param review what rideReview() returns */
export function rideChartSvg(review) {
  const { width, height, left, right, top, split, powerTop, base } = RIDE_PLOT;
  const n = review.seconds;
  if (n < 30) return '<p class="muted">Ride for half a minute to see the chart.</p>';
  const { levelMax, wattsMax, x, yLevel, yWatts } = rideScales(review);
  const every = Math.max(1, Math.ceil(n / 600)); // enough points for the width, however long the ride
  const points = (values, y) => {
    const pts = [];
    for (let i = 0; i < n; i += every) pts.push(`${x(i + 0.5).toFixed(1)},${y(values[i]).toFixed(1)}`);
    return pts.join('L');
  };
  const grid = (y) => `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${P.ink}" opacity=".08"/>`;
  const tick = (y, text) => `<text x="${left - 7}" y="${y + 4}" text-anchor="end" font-size="11" fill="${P.muted}">${text}</text>`;
  let s = '';

  // Block names along the top, and a faint divider down each panel. A ride of
  // many short steps has too many to name.
  if (review.spans.length <= 16) {
    review.spans.forEach((sp, i) => {
      if (sp.from >= n) return;
      const x0 = x(sp.from), x1 = x(Math.min(sp.to, n));
      s += `<rect x="${(x0 + 1.5).toFixed(1)}" y="6" width="${Math.max(0, x1 - x0 - 3).toFixed(1)}" height="22" rx="11" fill="${i % 2 ? '#F1E4D6' : '#F8EEE3'}"/>`;
      if (sp.name.length * 6.4 + 12 <= x1 - x0) s += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="21" text-anchor="middle" font-size="11" fill="${P.inkSoft}">${esc(sp.name)}</text>`;
      if (i) for (const [y1, y2] of [[top, split], [powerTop - 8, base]]) s += `<line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${y1}" y2="${y2}" stroke="#EDE2D6" stroke-dasharray="2 4"/>`;
    });
  }

  // Power: a filled area on its own scale, smoothed over ten seconds.
  const watts = smoothed(review.watts, 5);
  s += `<path d="M${x(0.5).toFixed(1)},${base}L${points(watts, yWatts)}L${x(n - 0.5).toFixed(1)},${base}Z" fill="${RIDE_COLORS.watts}"/>`;
  const wattsStep = wattsMax <= 300 ? 100 : wattsMax <= 600 ? 200 : Math.ceil(wattsMax / 300) * 100;
  for (let v = wattsStep; v <= wattsMax; v += wattsStep) s += grid(yWatts(v)) + tick(yWatts(v), `${v} W`);
  s += `<text x="${left}" y="${powerTop - 18}" font-size="12" fill="${P.ink}">Power</text>`;
  s += `<text x="${right + 10}" y="${(yWatts(watts[n - 1]) + 4).toFixed(1)}" font-size="12" fill="${RIDE_COLORS.wattsText}">Watts</text>`;

  // Cadence and resistance: the target as a thin dashed line, what you did as a solid one.
  for (let v = 20; v < levelMax; v += 20) s += grid(yLevel(v)) + tick(yLevel(v), v);
  s += `<line x1="${left}" x2="${right}" y1="${split}" y2="${split}" stroke="#E3D3C3" stroke-width="2"/>${tick(split, 0)}`;
  for (const [key, name] of [['cadence', 'Cadence'], ['resistance', 'Resistance']]) {
    const color = RIDE_COLORS[key];
    let aim = '';
    for (let i = 0; i < n; i++) {
      const v = review.targets[i][key];
      if (i && v === review.targets[i - 1][key]) continue;
      aim += i ? `H${x(i).toFixed(1)}V${yLevel(v).toFixed(1)}` : `M${x(0).toFixed(1)},${yLevel(v).toFixed(1)}`;
    }
    const did = smoothed(review[key], 2);
    s += `<path d="${aim}H${x(n).toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="4 3" opacity=".55"/>`;
    s += `<path d="M${points(did, yLevel)}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    s += `<text x="${right + 10}" y="${(yLevel(did[n - 1]) + 4).toFixed(1)}" font-size="12" fill="${color}">${name}</text>`;
  }

  // Where you were off target: a strip under the chart.
  s += `<rect x="${left}" y="${base + 5}" width="${right - left}" height="6" rx="3" fill="#F1E4D6"/>`;
  for (const [from, to] of review.misses) s += `<rect x="${x(from).toFixed(1)}" y="${base + 5}" width="${Math.max(3, x(to) - x(from)).toFixed(1)}" height="6" rx="3" fill="${RIDE_COLORS.miss}"/>`;

  // Time along the bottom, and a key for the two marks that need one.
  const minutes = n / 60;
  const minuteStep = minutes <= 6 ? 1 : minutes <= 14 ? 2 : minutes <= 65 ? 5 : 10;
  for (let m = 0; m <= minutes; m += minuteStep) s += `<text x="${x(m * 60).toFixed(1)}" y="${base + 30}" text-anchor="middle" font-size="11" fill="${P.muted}">${m ? `${m} min` : '0'}</text>`;
  const keyY = base + 56;
  s += `<line x1="${left}" x2="${left + 22}" y1="${keyY}" y2="${keyY}" stroke="${P.inkSoft}" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${left + 28}" y="${keyY + 4}" font-size="11" fill="${P.muted}">target</text>`;
  s += `<rect x="${left + 80}" y="${keyY - 3}" width="22" height="6" rx="3" fill="${RIDE_COLORS.miss}"/><text x="${left + 108}" y="${keyY + 4}" font-size="11" fill="${P.muted}">off target</text>`;

  // The hover cursor, moved by summary.js.
  s += `<line id="ride-cursor" x1="0" x2="0" y1="${top}" y2="${base}" stroke="${P.ink}" stroke-width="1" visibility="hidden"/>`;
  for (const key of ['cadence', 'resistance']) s += `<circle id="ride-dot-${key}" r="5" fill="${RIDE_COLORS[key]}" stroke="#fff" stroke-width="2" visibility="hidden"/>`;

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cadence, resistance and power over the ride, against the targets">${s}</svg>`;
}

// Plot area of the bike model chart, shared with the hover readout in app.js.
export const MODEL_PLOT = { width: 468, height: 230, left: 40, right: 60, top: 10, bottom: 30 };
export const MODEL_CADENCES = [
  { rpm: 50, color: '#B7791F' },
  { rpm: 70, color: '#159A9C' },
  { rpm: 85, color: '#6A55B8' },
  { rpm: 100, color: '#C95A43' },
];

/** Resistance range the model chart covers: the measured levels plus a little either side. */
export function modelRange(model) {
  if (!model.knots) return { lo: 10, hi: 90, from: 10, to: 90 };
  const from = model.knots[0][0];
  const to = model.knots[model.knots.length - 1][0];
  return { lo: Math.max(1, from - 10), hi: Math.min(100, to + 10), from, to };
}

/**
 * The bike's formula as a chart: watts against resistance, one line per cadence.
 * Solid where levels were measured, dashed where the model is extending beyond them.
 */
export function modelSvg(model) {
  const { width, height, left, right, top, bottom } = MODEL_PLOT;
  const { lo, hi, from, to } = modelRange(model);
  const top_rpm = MODEL_CADENCES[MODEL_CADENCES.length - 1].rpm;
  const maxW = Math.ceil(powerFor(model, hi, top_rpm) / 100) * 100;
  const x = (r) => left + ((r - lo) / (hi - lo)) * (width - left - right);
  const y = (w) => top + (1 - w / maxW) * (height - top - bottom);
  const path = (rpm, a, b) => {
    let d = '';
    for (let r = a; r <= b + 1e-9; r += 1) d += `${d ? 'L' : 'M'}${x(r).toFixed(1)},${y(powerFor(model, r, rpm)).toFixed(1)}`;
    return d;
  };
  const grid = [];
  for (let w = 0; w <= maxW; w += maxW > 600 ? 200 : 100) {
    grid.push(`<line x1="${left}" x2="${width - right}" y1="${y(w).toFixed(1)}" y2="${y(w).toFixed(1)}" stroke="#E3D3C3" stroke-width="1"/>
      <text x="${left - 6}" y="${(y(w) + 4).toFixed(1)}" text-anchor="end">${w}</text>`);
  }
  const ticks = [];
  for (let r = Math.ceil(lo / 10) * 10; r <= hi; r += 10) {
    ticks.push(`<text x="${x(r).toFixed(1)}" y="${height - bottom + 16}" text-anchor="middle">${r}</text>`);
  }
  // A short tick under the axis for every level that has been measured.
  const rug = (model.knots ?? []).map(([r]) => `<line x1="${x(r).toFixed(1)}" x2="${x(r).toFixed(1)}" y1="${height - bottom}" y2="${height - bottom + 5}" stroke="${P.inkSoft}" stroke-width="2"/>`).join('');
  const lines = MODEL_CADENCES.map(({ rpm, color }) => {
    const stroke = `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    const dashed = `${stroke} stroke-dasharray="2 5"`;
    return `${lo < from ? `<path d="${path(rpm, lo, from)}" ${dashed}/>` : ''}
      <path d="${path(rpm, from, to)}" ${stroke}/>
      ${hi > to ? `<path d="${path(rpm, to, hi)}" ${dashed}/>` : ''}
      <text x="${width - right + 6}" y="${(y(powerFor(model, hi, rpm)) + 4).toFixed(1)}">${rpm} rpm</text>`;
  }).join('');
  return `<svg id="model-svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Watts at each resistance level, at ${MODEL_CADENCES.map((c) => c.rpm).join(', ')} rpm" font-size="11" font-weight="700" fill="${P.muted}">
    ${grid.join('')}${ticks.join('')}${rug}
    <text x="${(left + width - right) / 2}" y="${height - 1}" text-anchor="middle">Resistance</text>
    ${lines}
    <line id="model-cross" x1="0" x2="0" y1="${top}" y2="${height - bottom}" stroke="${P.ink}" stroke-width="1" visibility="hidden"/>
  </svg>`;
}

/** Minutes ridden in each of the last few weeks: [{ label, minutes }], oldest first. */
export function weeksSvg(weeks, width = 960, height = 170) {
  const top = 22;
  const bottom = 24;
  const max = Math.max(30, ...weeks.map((w) => w.minutes));
  const slot = width / weeks.length;
  const bw = Math.min(64, slot - 24);
  const bars = weeks.map((w, i) => {
    const cx = i * slot + slot / 2;
    const h = (w.minutes / max) * (height - top - bottom);
    const y = height - bottom - h;
    return `${w.minutes ? `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${P.teal}"><title>Week of ${esc(w.label)}: ${w.minutes} min</title></rect>
      <text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" fill="${P.ink}">${w.minutes}</text>` : ''}
      <text x="${cx.toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(w.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Minutes ridden each week" font-size="13" font-weight="700" fill="${P.muted}">
    ${bars}<rect x="0" y="${height - bottom - 1}" width="${width}" height="2" fill="#E3D3C3"/></svg>`;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
