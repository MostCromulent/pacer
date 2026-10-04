// Workout generation: the kinds of ride, their codes, and the shell every ride
// shares (warm-up, main set, cool-down, sprint gates, labels).
//
// It is rule-based and deterministic: the same code always produces the same
// workout, which is what makes ghost races fair. Rides that vary use a random
// generator seeded from the code, so they are still identical every time.
//
// A code is TYPE-MINUTES-VERSION, e.g. HIL-45-K7Q. Versions K7Q, R2M and X9D
// are a ride's three standard ones; any other three characters are a random
// version. Spin classes may add a fourth part listing the blocks left out.
//
// The main sets are built in rides.js and spinclass.js.

import { excludeMask, excludeFromMask } from './spinclass.js';
import { makeBuilders } from './rides.js';

export { SPIN_BLOCKS } from './spinclass.js';

export const TYPES = [
  { id: 'spinclass', blocks: true, group: 'Spin class', name: 'Spin class', hint: 'An instructor-style class: climbs, pushes, jumps and sprints in short blocks, building in waves to a big finish', code: 'SPN' },
  { id: 'spinlow', blocks: true, group: 'Spin class', name: 'Low impact class', hint: 'The same class kept in the saddle: gentler efforts, no sprints, and resistance never above 50', code: 'SPL' },
  { id: 'endurance', group: 'Steady', name: 'Endurance', hint: 'Steady, chatty pace', code: 'END' },
  { id: 'recovery', group: 'Steady', name: 'Recovery spin', hint: 'Easy legs, light resistance', code: 'REC' },
  { id: 'lowimpact', group: 'Steady', name: 'Low impact', hint: 'Seated, moderate, gentle rises', code: 'LOW' },
  { id: 'sweetspot', group: 'Steady', name: 'Sweet spot', hint: 'Long, hard blocks', code: 'SST' },
  { id: 'progression', group: 'Steady', name: 'Progression', hint: 'Starts easy, builds to the finish', code: 'PRG' },
  { id: 'hills', group: 'Natural', name: 'Rolling hills', hint: 'Ups, downs and flats, like outdoors', code: 'HIL' },
  { id: 'mountain', group: 'Natural', name: 'Mountain climb', hint: 'Long climbs that build to a summit', code: 'MTN' },
  { id: 'fartlek', group: 'Natural', name: 'Fartlek', hint: 'Easy riding with surprise surges', code: 'FRT' },
  { id: 'intervals', group: 'Intervals', name: 'Intervals', hint: 'Hard / easy repeats', code: 'INT' },
  { id: 'climbs', group: 'Intervals', name: 'Climb repeats', hint: 'The same hill, slow and heavy', code: 'CLB' },
  { id: 'hiit', group: 'Intervals', name: 'HIIT', hint: 'Tabata-style short, sharp blocks', code: 'HIT' },
  { id: 'pyramid', group: 'Intervals', name: 'Pyramid', hint: 'Up the ladder, back down', code: 'PYR' },
  { id: 'sprints', group: 'Intervals', name: 'Sprints', hint: 'Short all-out bursts', code: 'SPR' },
  { id: 'cadence', group: 'Intervals', name: 'Cadence drills', hint: 'Spin fast, low effort', code: 'CAD' },
  { id: 'mix', group: 'Mixed', name: 'Mix it up', hint: 'A natural ride, then intervals', code: 'MIX' },
];

export const DURATIONS = [
  { min: 22, label: 'sitcom' },
  { min: 30, label: 'half hour' },
  { min: 45, label: 'drama' },
  { min: 60, label: 'double' },
];

// Every ride comes in three standard versions, 0-2, with these codes. Versions
// from 3 up are random ones: the number is the seed, written in base 36.
export const VARIANT_CODES = ['K7Q', 'R2M', 'X9D'];
export const RANDOM_VARIANTS = 36 ** 3;

function variantCode(variant) {
  return variant < 3 ? VARIANT_CODES[variant] : (variant - 3).toString(36).toUpperCase().padStart(3, '0');
}

/** A random version number that isn't one of the three standard ones. */
export function randomVariant(random = Math.random) {
  for (;;) {
    const variant = 3 + Math.floor(random() * RANDOM_VARIANTS);
    if (!VARIANT_CODES.includes(variantCode(variant))) return variant;
  }
}

// "Mix it up" pairs a natural first half with an interval second half.
const MIXES = [
  { natural: 'hills', intervals: 'hiit', name: 'Mix: rolling hills + HIIT' },
  { natural: 'mountain', intervals: 'sprints', name: 'Mix: mountain + sprints' },
  { natural: 'fartlek', intervals: 'intervals', name: 'Mix: fartlek + intervals' },
];

// Zone boundaries as % of baseline power.
export function zoneOf(pct) {
  if (pct < 60) return 1;
  if (pct < 76) return 2;
  if (pct < 91) return 3;
  if (pct < 106) return 4;
  return 5;
}

/** Whether a ride is a spin class, built from blocks that can be left out. */
export function hasBlocks(type) {
  return !!TYPES.find((t) => t.id === type)?.blocks;
}

/** `exclude`: spin class blocks left out; they add a fourth part to the code. */
export function workoutCode(type, minutes, variant, exclude = []) {
  const t = TYPES.find((x) => x.id === type);
  if (!t) throw new Error(`Unknown workout type: ${type}`);
  const mask = hasBlocks(type) ? excludeMask(exclude) : 0;
  return `${t.code}-${minutes}-${variantCode(variant)}${mask ? `-${mask.toString(36).toUpperCase()}` : ''}`;
}

export function parseWorkoutCode(code) {
  const m = /^([A-Z]{3})-(\d{1,3})-([A-Z0-9]{3})(?:-([A-Z0-9]{1,4}))?$/.exec(String(code).trim().toUpperCase());
  if (!m) return null;
  const type = TYPES.find((x) => x.code === m[1]);
  const named = VARIANT_CODES.indexOf(m[3]);
  const variant = named >= 0 ? named : 3 + parseInt(m[3], 36);
  const minutes = Number(m[2]);
  if (!type || minutes < 10 || minutes > 120) return null;
  if (m[4]) {
    if (!hasBlocks(type.id)) return null;
    return { type: type.id, minutes, variant, exclude: excludeFromMask(parseInt(m[4], 36)) };
  }
  return { type: type.id, minutes, variant };
}

/**
 * One step of a ride.
 * @typedef {object} Step
 * @property {number} start        seconds from the start of the ride
 * @property {number} dur          length in seconds
 * @property {number} pct          effort, as a percentage of the rider's baseline power
 * @property {'warmup'|'work'|'recovery'|'steady'|'sprint'|'drill'|'cooldown'} kind
 * @property {number} cadence      target rpm
 * @property {string} label        what the step is called on screen ("Hill 2 of 6")
 * @property {string} [name]       the label without its count ("Hill")
 * @property {'seated'|'standing'} position
 * @property {boolean} [hold]      keep the previous step's resistance; only the cadence changes
 * @property {boolean} [creep]     one step of a creeping climb, where only the resistance moves
 * @property {number} [resistanceCap]  a ceiling on the step's resistance target
 * @property {string} [block]      the spin class block this step belongs to
 * @property {boolean} [blockStart] the first step of that block
 * @property {number} [rounds]     how many times the block repeats (on its first step)
 *
 * Builders create steps with add(seconds, pct, kind, options); `stand: true` in
 * the options becomes `position: 'standing'`.
 */

/**
 * Build a workout.
 * Segments: { start, dur (seconds), pct (% of baseline), kind, cadence, name?, label }
 * kind: 'warmup' | 'work' | 'recovery' | 'steady' | 'sprint' | 'drill' | 'cooldown'
 * `name` (optional) is what the step is called in the app ("Hill", "Rep", "Descent").
 * `hold: true` means "keep the previous step's resistance, change only cadence".
 * `creep: true` marks one step of a creeping climb, where only the resistance moves.
 * `block` names the spin class block a step belongs to; `blockStart` marks its
 * first step, with `rounds` when the block repeats. `resistanceCap` is a ceiling on
 * the step's resistance target.
 * `options.exclude` lists spin class blocks to leave out.
 * `position` is 'seated' or 'standing' (out of the saddle); steps are seated
 * unless they are built with `stand: true`.
 */
export function generateWorkout(type, minutes, variant = 0, options = {}) {
  variant = Math.max(0, Math.floor(variant));
  const exclude = hasBlocks(type) ? excludeFromMask(excludeMask(options.exclude)) : [];
  const v = variant % 3; // which of a ride's three styles to use
  const segs = [];
  // All durations in whole seconds, so the parts always add up exactly.
  const add = (sec, pct, kind, opts = {}) => {
    const dur = Math.round(sec);
    if (dur <= 0) return;
    segs.push({ dur, pct: Math.round(pct), kind, ...opts });
  };
  const rand = seeded(`${type}-${minutes}-${variant}${exclude.length ? `-${excludeMask(exclude)}` : ''}`);

  const warm = Math.min(5, Math.max(3, Math.round(minutes * 0.13)));
  const cool = Math.min(5, Math.max(3, Math.round(minutes * 0.1)));
  const main = (minutes - warm - cool) * 60;

  const gentle = type === 'recovery' || type === 'lowimpact' || type === 'spinlow';
  const warmTop = gentle ? 58 : 72;
  for (let i = 0; i < warm; i++) add(60, 45 + ((i + 1) / warm) * (warmTop - 45), 'warmup');

  const builders = makeBuilders(add, v, rand, exclude);
  if (type === 'mix') {
    const mix = MIXES[v];
    const half = Math.floor(main / 120) * 60;
    builders[mix.natural](half);
    builders[mix.intervals](main - half);
  } else {
    builders[type](main);
  }

  for (let i = 0; i < cool; i++) add(60, (gentle ? 58 : 65) - (i / cool) * 20, 'cooldown');

  let t = 0;
  for (const s of segs) {
    s.start = t;
    t += s.dur;
    if (!s.cadence) s.cadence = targetCadenceFor(s);
    s.position = s.stand ? 'standing' : 'seated';
    delete s.stand;
  }

  const name = type === 'mix' ? MIXES[v].name : TYPES.find((x) => x.id === type)?.name ?? type;
  const workout = {
    code: workoutCode(type, minutes, variant, exclude),
    type,
    name,
    minutes,
    variant,
    options: { exclude },
    totalS: t,
    segments: segs,
  };
  workout.gates = computeGates(workout);
  labelSteps(workout);
  return workout;
}

// Target cadence for each step, spin-class style: heavy climbs are ridden slower
// with more resistance (hills and mountains set their own, down to 60 rpm), short hard efforts spin faster, and recoveries ease off to 75 rpm. Together
// with the step's power this fixes the resistance for the step.
function targetCadenceFor(s) {
  switch (s.kind) {
    case 'sprint': return 105;
    case 'work': return s.pct >= 110 ? 95 : s.pct >= 100 ? 80 : 85;
    case 'recovery': return 75;
    case 'steady': return 88;
    default: return 85;
  }
}

// Sprint gates: every sprint in full, and the last 30 s of every hard block of
// a minute or more, but only at the top: not when the next step is as hard.
function computeGates(workout) {
  const gates = [];
  const segs = workout.segments;
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    if (s.kind === 'sprint') gates.push({ start: s.start, end: s.start + s.dur });
    else if (s.kind === 'work' && s.pct >= 91 && s.dur >= 60 && !(next?.kind === 'work' && next.pct >= s.pct)) {
      gates.push({ start: s.start + s.dur - 30, end: s.start + s.dur });
    }
  });
  return gates.map((g, i) => ({ ...g, index: i }));
}

const DEFAULT_NAMES = {
  work: 'Climb', sprint: 'Sprint', drill: 'Spin drill', warmup: 'Warm-up', cooldown: 'Cool-down', recovery: 'Recover', steady: 'Cruise',
};

// Hard steps are numbered within their name ("Hill 2 of 6"); the rest just get a name.
function labelSteps(workout) {
  const counted = (s) => !s.label && (s.kind === 'work' || s.kind === 'sprint' || s.kind === 'drill');
  const totals = new Map();
  for (const s of workout.segments) {
    if (!counted(s)) continue;
    const n = s.name ?? DEFAULT_NAMES[s.kind];
    totals.set(n, (totals.get(n) ?? 0) + 1);
  }
  const seen = new Map();
  for (const s of workout.segments) {
    if (s.label) continue;
    const n = s.name ?? DEFAULT_NAMES[s.kind];
    if (counted(s)) {
      seen.set(n, (seen.get(n) ?? 0) + 1);
      s.label = totals.get(n) > 1 ? `${n} ${seen.get(n)} of ${totals.get(n)}` : n;
    } else {
      s.label = n;
    }
  }
}

export function segmentIndexAt(workout, t) {
  const segs = workout.segments;
  if (t <= 0) return 0;
  for (let i = 0; i < segs.length; i++) {
    if (t < segs[i].start + segs[i].dur) return i;
  }
  return segs.length - 1;
}

/** Intensity (% of baseline) at time t. */
export function pctAt(workout, t) {
  return workout.segments[segmentIndexAt(workout, t)].pct;
}

/** `effort` scales every step, as the rider's effort setting does (1 = as written). */
export function workoutStats(workout, baselineW, effort = 1) {
  const total = workout.totalS;
  let hard = 0;
  let sum = 0;
  let sq = 0;
  for (const s of workout.segments) {
    const pct = s.pct * effort;
    if (pct >= 91) hard += s.dur;
    sum += s.dur * pct;
    sq += s.dur * (pct / 100) ** 2;
  }
  const intensity = Math.sqrt(sq / total);
  return {
    hardMinutes: Math.round((hard / 60) * 10) / 10,
    avgTargetW: Math.round((sum / total / 100) * baselineW),
    score: Math.max(1, Math.min(10, Math.round(intensity * 12 - 3))),
  };
}

function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
