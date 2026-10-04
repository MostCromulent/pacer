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
 */
export function profileSvg(workout, width, height, effort = 1) {
  const total = workout.totalS;
  const gap = 2;
  let x = 0;
  const rects = workout.segments.map((s) => {
    const w = Math.max(1, (s.dur / total) * width - gap);
    const pct = s.pct * effort;
    const h = Math.round(14 + (Math.min(pct, 150) / 150) * (height - 20));
    const r = `<rect x="${x.toFixed(1)}" y="${height - h}" width="${w.toFixed(1)}" height="${h}" rx="${Math.min(6, w / 2).toFixed(1)}" fill="${ZONE_COLORS[zoneOf(pct)]}"/>`;
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

/** Gap to the ghost per minute: teal bars up when ahead, coral bars down when behind. */
export function gapChartSvg(gaps, width = 960, height = 150) {
  if (!gaps.length) return '<p class="muted">Ride a full minute to see the race chart.</p>';
  const maxUp = Math.max(1, ...gaps.map((g) => Math.max(0, g)));
  const maxDown = Math.max(1, ...gaps.map((g) => Math.max(0, -g)));
  const upH = Math.round(height * (maxUp / (maxUp + maxDown)) * 0.9 + height * 0.05);
  const zero = Math.max(12, Math.min(height - 12, upH));
  const bw = width / gaps.length;
  const bars = gaps
    .map((g, i) => {
      const x = (i * bw + 2).toFixed(1);
      const w = Math.max(2, bw - 4).toFixed(1);
      if (g >= 0) {
        const h = Math.max(1, (g / maxUp) * (zero - 4));
        return `<rect x="${x}" y="${(zero - h).toFixed(1)}" width="${w}" height="${h.toFixed(1)}" rx="3" fill="${P.teal}"/>`;
      }
      const h = Math.max(1, (-g / maxDown) * (height - zero - 4));
      return `<rect x="${x}" y="${zero}" width="${w}" height="${h.toFixed(1)}" rx="3" fill="${P.coral}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img" aria-label="Gap to the ghost each minute">
    ${bars}<rect x="0" y="${zero - 1}" width="${width}" height="2" fill="#E3D3C3"/></svg>`;
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
