// Small SVG builders for the setup preview, the route strip and the summary.
// All inputs are numbers or text we generate ourselves; text is escaped anyway.

import { zoneOf } from '../core/workout.js';
import { ZONE_COLORS, P } from './palette.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Workout preview: one rounded block per step, height by intensity, colour by zone. */
export function profileSvg(workout, width, height) {
  const total = workout.totalS;
  const gap = 2;
  let x = 0;
  const rects = workout.segments.map((s) => {
    const w = Math.max(1, (s.dur / total) * width - gap);
    const h = Math.round(14 + (Math.min(s.pct, 150) / 150) * (height - 20));
    const r = `<rect x="${x.toFixed(1)}" y="${height - h}" width="${w.toFixed(1)}" height="${h}" rx="${Math.min(6, w / 2).toFixed(1)}" fill="${ZONE_COLORS[zoneOf(s.pct)]}"/>`;
    x += (s.dur / total) * width;
    return r;
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

/** Route strip for the mini window: the workout as paper hills, gate flags and a playhead. */
export function routeSvg(workout, width = 328, height = 56) {
  const total = workout.totalS;
  let d = `M0,${height}`;
  for (const s of workout.segments) {
    const x0 = (s.start / total) * width;
    const x1 = ((s.start + s.dur) / total) * width;
    const y = (height - (6 + (Math.min(s.pct, 150) / 150) * (height - 12))).toFixed(1);
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
export function updateRoute(root, workout, t, width = 328, height = 56) {
  const x = Math.max(0, Math.min(width, (t / workout.totalS) * width));
  const rect = root.querySelector('#route-past-rect');
  const dot = root.querySelector('#route-dot');
  if (!rect || !dot) return;
  rect.setAttribute('width', x.toFixed(1));
  let si = workout.segments.findIndex((s) => t < s.start + s.dur);
  if (si < 0) si = workout.segments.length - 1;
  const pct = workout.segments[si].pct;
  dot.setAttribute('cx', x.toFixed(1));
  dot.setAttribute('cy', (height - (6 + (Math.min(pct, 150) / 150) * (height - 12))).toFixed(1));
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
