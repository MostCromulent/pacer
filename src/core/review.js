// A finished ride looked back on: what the rider did each second against the
// target, where they were off it, and how each block went.

import { stepTargets, isOnTarget } from './ride.js';

const GRACE_S = 8; // time allowed to reach a new target before it counts as a miss
const MIN_MISS_S = 4; // shorter slips than this aren't worth showing

/** A step's name without its counter: "Hill 2 of 4" and "Tabata 1 · rep 3/8" become "Hill" and "Tabata". */
function plainName(seg) {
  if (seg.kind === 'warmup') return 'Warm-up';
  if (seg.kind === 'cooldown') return 'Cool-down';
  return seg.block ?? seg.name ?? seg.label.replace(/\s*·.*$/, '').replace(/\s+\d+(\s+of\s+\d+|\/\d+)?$/, '');
}

/**
 * The ride as a run of named spans: a spin class's blocks, or otherwise each
 * stretch of steps with the same name. Times are in seconds; `segs` are the
 * indexes of the steps in each span.
 */
export function rideSpans(workout) {
  const spans = [];
  workout.segments.forEach((seg, i) => {
    const name = plainName(seg);
    const last = spans.at(-1);
    if (last && last.name === name && !seg.blockStart) {
      last.to = seg.start + seg.dur;
      last.segs.push(i);
    } else {
      spans.push({ name, from: seg.start, to: seg.start + seg.dur, segs: [i] });
    }
  });
  return spans;
}

/** How far outside a range a reading is: 0 inside it, negative below, positive above. */
function outside(have, [lo, hi]) {
  if (have < lo) return have - lo;
  return hi !== null && have > hi ? have - hi : 0;
}

/**
 * @param {import('./ride.js').RideSession} session a ride that has been ridden
 * @returns {{
 *   seconds: number,
 *   watts: number[], cadence: number[], resistance: number[],
 *   targets: object[],            the step targets in force each second
 *   spanAt: number[],             index into `spans` for each second
 *   spans: {name: string, from: number, to: number, onTargetPct: number, rest: boolean}[],
 *   misses: [number, number][],   stretches off target, as [from, to) seconds
 *   rows: object[],               one line per block (or per kind of step) for the table
 * }}
 */
export function rideReview(session) {
  const { workout, samples, model, baselineW } = session;
  const segments = workout.segments;
  const seconds = samples.p.length;
  const spans = rideSpans(workout);
  const spanOfSeg = [];
  spans.forEach((sp, i) => { for (const si of sp.segs) spanOfSeg[si] = i; });

  // Targets move with the effort setting, so they are worked out for the effort at the time.
  const cache = new Map();
  const targetsAt = (si, effort) => {
    const key = `${si}:${effort}`;
    if (!cache.has(key)) cache.set(key, stepTargets(segments[si], segments, baselineW * effort, model));
    return cache.get(key);
  };

  const targets = [], spanAt = [], segAt = [], off = [];
  let si = 0, changedAt = 0;
  for (let i = 0; i < seconds; i++) {
    while (si < segments.length - 1 && i + 0.5 >= segments[si].start + segments[si].dur) si++;
    const effort = samples.e?.[i] ?? session.effort;
    const tg = targetsAt(si, effort);
    if (i && tg !== targets[i - 1] && (tg.cadence !== targets[i - 1].cadence || tg.resistance !== targets[i - 1].resistance)) changedAt = i;
    targets.push(tg);
    segAt.push(si);
    spanAt.push(spanOfSeg[si]);
    const matched = outside(samples.c[i], tg.cadenceRange) === 0 && outside(samples.r[i], tg.resistanceRange) === 0;
    const onTarget = matched || isOnTarget(segments[si], baselineW * effort, samples.p[i], samples.c[i]);
    off.push(!onTarget && i - changedAt >= GRACE_S);
  }

  const misses = [];
  for (let i = 0, from = -1; i <= seconds; i++) {
    if (off[i] && from < 0) from = i;
    if (!off[i] && from >= 0) {
      if (i - from >= MIN_MISS_S) misses.push([from, i]);
      from = -1;
    }
  }

  // A spin class reads block by block. Other rides repeat a few kinds of step
  // (hill, descent, flat), so those are gathered: "Hill ×4".
  const groups = new Map();
  spans.forEach((sp, i) => {
    const key = workout.segments[sp.segs[0]].block ? i : sp.name;
    if (!groups.has(key)) groups.set(key, { name: sp.name, count: 0, spans: new Set() });
    const g = groups.get(key);
    g.count++;
    g.spans.add(i);
  });
  const rows = [];
  for (const g of groups.values()) {
    const row = { name: g.count > 1 ? `${g.name} ×${g.count}` : g.name, seconds: 0, on: 0, total: 0, w: 0, c: 0, r: 0, cOff: 0, rOff: 0 };
    for (let i = 0; i < seconds; i++) {
      if (!g.spans.has(spanAt[i])) continue;
      row.seconds++;
      row.w += samples.p[i];
      row.c += samples.c[i];
      row.r += samples.r[i];
      row.cOff += outside(samples.c[i], targets[i].cadenceRange);
      row.rOff += outside(samples.r[i], targets[i].resistanceRange);
    }
    if (!row.seconds) continue; // the ride ended before this block
    for (const sp of g.spans) for (const s of spans[sp].segs) { row.on += session.segOnTarget[s].on; row.total += session.segOnTarget[s].total; }
    const n = row.seconds;
    rows.push({
      name: row.name,
      // The planned length of the block, or of all the steps gathered on this line.
      lengthS: [...g.spans].reduce((a, sp) => a + spans[sp].to - spans[sp].from, 0),
      rest: [...g.spans].every((sp) => spans[sp].segs.every((i) => segments[i].kind === 'recovery')),
      onTargetPct: row.total ? Math.round((row.on / row.total) * 100) : 0,
      avgW: Math.round(row.w / n),
      avgCadence: Math.round(row.c / n),
      avgResistance: Math.round(row.r / n),
      // The average distance outside the target range: 0 when it was held.
      cadenceOff: Math.round(row.cOff / n) || 0,
      resistanceOff: Math.round(row.rOff / n) || 0,
    });
  }

  return {
    seconds,
    watts: samples.p,
    cadence: samples.c,
    resistance: samples.r,
    targets,
    spanAt,
    spans: spans.map(({ name, from, to, segs }) => {
      const on = segs.reduce((a, i) => a + session.segOnTarget[i].on, 0);
      const total = segs.reduce((a, i) => a + session.segOnTarget[i].total, 0);
      // A recovery isn't marked: nobody needs a score for resting.
      return { name, from, to, onTargetPct: total ? Math.round((on / total) * 100) : 0, rest: segs.every((i) => segments[i].kind === 'recovery') };
    }),
    misses,
    rows,
  };
}

/**
 * One plain sentence or two on how the ride went, from the lines of its
 * review: where the targets were held best, and where they were hardest to
 * hold and why. Empty if there is too little to say.
 */
export function rideVerdict(review) {
  const scored = review.rows.filter((r) => !r.rest);
  if (scored.length < 2) return '';
  const best = scored.reduce((a, b) => (b.onTargetPct > a.onTargetPct ? b : a));
  const worst = scored.reduce((a, b) => (b.onTargetPct < a.onTargetPct ? b : a));
  if (worst.onTargetPct >= 90) return 'On target all the way through.';
  const why = worst.resistanceOff <= -1 ? 'the resistance ran a little low'
    : worst.resistanceOff >= 1 ? 'the resistance ran a little high'
      : worst.cadenceOff <= -1 ? 'the cadence dropped a little'
        : worst.cadenceOff >= 1 ? 'the cadence ran a little fast'
          : 'the targets were hard to hold';
  return `Best held: ${best.name} (${best.onTargetPct}%). Hardest to hold: ${worst.name} (${worst.onTargetPct}%), where ${why}.`;
}
