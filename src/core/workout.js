// Workout generation. Rule-based and deterministic: the same code always
// produces the same workout, which is what makes ghost races fair.

export const TYPES = [
  { id: 'endurance', name: 'Endurance', hint: 'Steady, chatty pace', code: 'END' },
  { id: 'tempo', name: 'Sweet spot', hint: 'Long, hard blocks', code: 'SST' },
  { id: 'intervals', name: 'Intervals', hint: 'Hard / easy repeats', code: 'INT' },
  { id: 'pyramid', name: 'Pyramid', hint: 'Up the ladder, back down', code: 'PYR' },
  { id: 'sprints', name: 'Sprints', hint: 'Short all-out bursts', code: 'SPR' },
  { id: 'cadence', name: 'Cadence drills', hint: 'Spin fast, low effort', code: 'CAD' },
  { id: 'surprise', name: 'Surprise me', hint: 'A random mix of the above', code: 'MIX' },
];

export const DURATIONS = [
  { min: 22, label: 'sitcom' },
  { min: 30, label: 'half hour' },
  { min: 45, label: 'drama' },
  { min: 60, label: 'double' },
];

export const VARIANT_CODES = ['K7Q', 'R2M', 'X9D'];

// Zone boundaries as % of baseline power.
export function zoneOf(pct) {
  if (pct < 60) return 1;
  if (pct < 76) return 2;
  if (pct < 91) return 3;
  if (pct < 106) return 4;
  return 5;
}

export function workoutCode(type, minutes, variant) {
  const t = TYPES.find((x) => x.id === type);
  if (!t) throw new Error(`Unknown workout type: ${type}`);
  return `${t.code}-${minutes}-${VARIANT_CODES[variant]}`;
}

export function parseWorkoutCode(code) {
  const m = /^([A-Z]{3})-(\d{1,3})-([A-Z0-9]{3})$/.exec(String(code).trim().toUpperCase());
  if (!m) return null;
  const type = TYPES.find((x) => x.code === m[1]);
  const variant = VARIANT_CODES.indexOf(m[3]);
  const minutes = Number(m[2]);
  if (!type || variant < 0 || minutes < 10 || minutes > 120) return null;
  return { type: type.id, minutes, variant };
}

/**
 * Build a workout.
 * Segments: { start, dur (seconds), pct (% of baseline), kind, cadence? }
 * kind: 'warmup' | 'work' | 'recovery' | 'steady' | 'sprint' | 'drill' | 'cooldown'
 */
export function generateWorkout(type, minutes, variant = 0) {
  const v = ((variant % 3) + 3) % 3;
  const segs = [];
  const add = (m, pct, kind, cadence) => {
    if (m <= 0) return;
    segs.push({ dur: Math.round(m * 60), pct, kind, ...(cadence ? { cadence } : {}) });
  };

  const warm = Math.max(3, Math.round(minutes * 0.13));
  const cool = Math.max(3, Math.round(minutes * 0.1));
  const main = minutes - warm - cool;

  for (let i = 0; i < warm; i++) add(1, Math.round(45 + ((i + 1) / warm) * 27), 'warmup');

  const build = (kind, budget) => {
    let left = budget;
    if (kind === 'endurance') {
      const blk = [5, 6, 4][v];
      const ps = [[65, 72], [68, 74], [62, 70]][v];
      let i = 0;
      while (left >= blk) { add(blk, ps[i % 2], 'steady'); left -= blk; i++; }
      add(left, ps[0], 'steady');
      left = 0;
    } else if (kind === 'tempo') {
      let n = left >= 24 ? [3, 2, 4][v] : 2;
      const rec = [3, 4, 2][v];
      if (Math.floor((left - rec * (n - 1)) / n) < 3) n = 1;
      const work = Math.floor((left - rec * (n - 1)) / n);
      for (let i = 0; i < n; i++) {
        add(work, 88, 'work');
        if (i < n - 1) add(rec, 55, 'recovery');
      }
      left -= work * n + rec * (n - 1);
    } else if (kind === 'intervals') {
      const [on, off] = [[3, 2], [4, 3], [2, 1]][v];
      while (left >= on + off) { add(on, 105, 'work'); add(off, 55, 'recovery'); left -= on + off; }
    } else if (kind === 'pyramid') {
      // The biggest ladder that fits (each needs its steps plus 1 min between them).
      const ladders = [[1, 2, 3, 4, 3, 2, 1], [1, 2, 3, 2, 1], [1, 2, 1], [1]];
      const fits = (s) => s.reduce((a, b) => a + b, 0) + s.length - 1 <= left;
      const steps = ladders.find(fits) ?? [];
      const peak = [115, 110, 120][v];
      steps.forEach((s, i) => {
        add(s, s <= 2 ? peak : peak - 12, 'work');
        if (i < steps.length - 1) add(1, 55, 'recovery');
      });
      left -= steps.length ? steps.reduce((a, b) => a + b, 0) + steps.length - 1 : 0;
    } else if (kind === 'sprints') {
      const [on, off] = [[0.5, 2.5], [0.25, 1.75], [0.5, 3.5]][v];
      while (left >= on + off) { add(on, 150, 'sprint'); add(off, 58, 'recovery'); left -= on + off; }
    } else if (kind === 'cadence') {
      const rpms = [70, 90, 110];
      const ps = [58, 63, 68];
      let i = 0;
      while (left >= 3) { add(3, ps[(i + v) % 3], 'drill', rpms[(i + v) % 3]); left -= 3; i++; }
    }
    add(left, 60, 'steady');
  };

  if (type === 'surprise') {
    const pairs = [['intervals', 'sprints'], ['tempo', 'pyramid'], ['pyramid', 'sprints']][v];
    const half = Math.floor(main / 2);
    build(pairs[0], half);
    build(pairs[1], main - half);
  } else {
    build(type, main);
  }

  for (let i = 0; i < cool; i++) add(1, Math.round(65 - (i / cool) * 20), 'cooldown');

  let t = 0;
  for (const s of segs) { s.start = t; t += s.dur; }

  const name = TYPES.find((x) => x.id === type)?.name ?? type;
  const workout = {
    code: workoutCode(type, minutes, v),
    type,
    name,
    minutes,
    variant: v,
    totalS: t,
    segments: segs,
  };
  workout.gates = computeGates(workout);
  labelSteps(workout);
  return workout;
}

export function workoutFromCode(code) {
  const p = parseWorkoutCode(code);
  return p ? generateWorkout(p.type, p.minutes, p.variant) : null;
}

// Sprint gates: the last 30 s of every hard block of a minute or more, and every
// sprint in full. They are short races against the ghost inside the workout.
function computeGates(workout) {
  const gates = [];
  for (const s of workout.segments) {
    if (s.kind === 'sprint') gates.push({ start: s.start, end: s.start + s.dur });
    else if (s.kind === 'work' && s.pct >= 91 && s.dur >= 60) gates.push({ start: s.start + s.dur - 30, end: s.start + s.dur });
  }
  return gates.map((g, i) => ({ ...g, index: i }));
}

function labelSteps(workout) {
  const hard = workout.segments.filter((s) => s.kind === 'work' || s.kind === 'sprint');
  const drills = workout.segments.filter((s) => s.kind === 'drill');
  let h = 0;
  let d = 0;
  for (const s of workout.segments) {
    if (s.kind === 'work') s.label = `Climb ${++h} of ${hard.length}`;
    else if (s.kind === 'sprint') s.label = `Sprint ${++h} of ${hard.length}`;
    else if (s.kind === 'drill') s.label = `Spin drill ${++d} of ${drills.length}`;
    else if (s.kind === 'warmup') s.label = 'Warm-up';
    else if (s.kind === 'cooldown') s.label = 'Cool-down';
    else if (s.kind === 'recovery') s.label = 'Recover';
    else s.label = 'Cruise';
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

/** Intensity (% of baseline) at time t, used to shape the road. */
export function pctAt(workout, t) {
  return workout.segments[segmentIndexAt(workout, t)].pct;
}

export function workoutStats(workout, baselineW) {
  const total = workout.totalS;
  let hard = 0;
  let sum = 0;
  let sq = 0;
  for (const s of workout.segments) {
    if (s.pct >= 91) hard += s.dur;
    sum += s.dur * s.pct;
    sq += s.dur * (s.pct / 100) ** 2;
  }
  const intensity = Math.sqrt(sq / total);
  return {
    hardMinutes: Math.round((hard / 60) * 10) / 10,
    avgTargetW: Math.round((sum / total / 100) * baselineW),
    effort: Math.max(1, Math.min(10, Math.round(intensity * 12 - 3))),
  };
}
