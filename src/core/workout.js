// Workout generation. Rule-based and deterministic: the same code always
// produces the same workout, which is what makes ghost races fair. "Natural"
// styles use a seeded random generator, so they vary like a real ride but are
// still identical every time for the same code.

export const TYPES = [
  { id: 'endurance', group: 'Steady', name: 'Endurance', hint: 'Steady, chatty pace', code: 'END' },
  { id: 'recovery', group: 'Steady', name: 'Recovery spin', hint: 'Easy legs, light resistance', code: 'REC' },
  { id: 'tempo', group: 'Steady', name: 'Sweet spot', hint: 'Long, hard blocks', code: 'SST' },
  { id: 'hills', group: 'Natural', name: 'Rolling hills', hint: 'Ups, downs and flats, like outdoors', code: 'HIL' },
  { id: 'mountain', group: 'Natural', name: 'Mountain climb', hint: 'Long climbs that build to a summit', code: 'MTN' },
  { id: 'fartlek', group: 'Natural', name: 'Fartlek', hint: 'Easy riding with surprise surges', code: 'FRT' },
  { id: 'intervals', group: 'Intervals', name: 'Intervals', hint: 'Hard / easy repeats', code: 'INT' },
  { id: 'hiit', group: 'Intervals', name: 'HIIT', hint: 'Tabata-style short, sharp blocks', code: 'HIT' },
  { id: 'pyramid', group: 'Intervals', name: 'Pyramid', hint: 'Up the ladder, back down', code: 'PYR' },
  { id: 'sprints', group: 'Intervals', name: 'Sprints', hint: 'Short all-out bursts', code: 'SPR' },
  { id: 'cadence', group: 'Intervals', name: 'Cadence drills', hint: 'Spin fast, low effort', code: 'CAD' },
  { id: 'spinclass', group: 'Mixed', name: 'Spin class', hint: 'Climbs, jumps and sprints in short blocks', code: 'SPN' },
  { id: 'surprise', group: 'Mixed', name: 'Mix it up', hint: 'A natural ride, then intervals', code: 'MIX' },
];

export const DURATIONS = [
  { min: 22, label: 'sitcom' },
  { min: 30, label: 'half hour' },
  { min: 45, label: 'drama' },
  { min: 60, label: 'double' },
];

export const VARIANT_CODES = ['K7Q', 'R2M', 'X9D'];

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
 * Segments: { start, dur (seconds), pct (% of baseline), kind, cadence, name?, label }
 * kind: 'warmup' | 'work' | 'recovery' | 'steady' | 'sprint' | 'drill' | 'cooldown'
 * `name` (optional) is what the step is called in the app ("Hill", "Rep", "Descent").
 * `hold: true` means "keep the previous step's resistance, change only cadence".
 */
export function generateWorkout(type, minutes, variant = 0) {
  const v = ((variant % 3) + 3) % 3;
  const segs = [];
  // All durations in whole seconds, so the parts always add up exactly.
  const add = (sec, pct, kind, opts = {}) => {
    const dur = Math.round(sec);
    if (dur <= 0) return;
    segs.push({ dur, pct: Math.round(pct), kind, ...opts });
  };
  const rand = seeded(`${type}-${minutes}-${v}`);

  const warm = Math.max(3, Math.round(minutes * 0.13));
  const cool = Math.max(3, Math.round(minutes * 0.1));
  const main = (minutes - warm - cool) * 60;

  const warmTop = type === 'recovery' ? 58 : 72;
  for (let i = 0; i < warm; i++) add(60, 45 + ((i + 1) / warm) * (warmTop - 45), 'warmup');

  const builders = makeBuilders(add, v, rand);
  if (type === 'surprise') {
    const mix = MIXES[v];
    const half = Math.floor(main / 120) * 60;
    builders[mix.natural](half);
    builders[mix.intervals](main - half);
  } else {
    builders[type](main);
  }

  for (let i = 0; i < cool; i++) add(60, (type === 'recovery' ? 58 : 65) - (i / cool) * 20, 'cooldown');

  let t = 0;
  for (const s of segs) {
    s.start = t;
    t += s.dur;
    if (!s.cadence) s.cadence = targetCadenceFor(s);
  }

  const name = type === 'surprise' ? MIXES[v].name : TYPES.find((x) => x.id === type)?.name ?? type;
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

/**
 * The main-set builders. Each takes a budget in seconds, spends what it can,
 * and fills any remainder with easy cruising, so the total is always exact.
 */
function makeBuilders(add, v, rand) {
  const cruise = (sec) => add(sec, 62, 'steady', { name: 'Cruise' });
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const step = (x, s = 15) => Math.round(x / s) * s;

  const b = {
    endurance(budget) {
      const blk = [5, 6, 4][v] * 60;
      const ps = [[65, 72], [68, 74], [62, 70]][v];
      let left = budget;
      let i = 0;
      while (left >= blk) { add(blk, ps[i % 2], 'steady'); left -= blk; i++; }
      add(left, ps[0], 'steady');
    },

    recovery(budget) {
      const blk = 300;
      const ps = [[55, 60], [52, 58], [58, 62]][v];
      let left = budget;
      let i = 0;
      while (left >= blk) { add(blk, ps[i % 2], 'steady', { cadence: 95, name: 'Easy spin' }); left -= blk; i++; }
      add(left, ps[0], 'steady', { cadence: 95, name: 'Easy spin' });
    },

    tempo(budget) {
      const mins = budget / 60;
      let n = mins >= 24 ? [3, 2, 4][v] : 2;
      const rec = [3, 4, 2][v];
      if (Math.floor((mins - rec * (n - 1)) / n) < 3) n = 1;
      const work = Math.floor((mins - rec * (n - 1)) / n);
      for (let i = 0; i < n; i++) {
        add(work * 60, 88, 'work');
        if (i < n - 1) add(rec * 60, 55, 'recovery');
      }
      cruise(budget - (work * n + rec * (n - 1)) * 60);
    },

    intervals(budget) {
      const [on, off] = [[3, 2], [4, 3], [2, 1]][v].map((m) => m * 60);
      let left = budget;
      while (left >= on + off) { add(on, 105, 'work'); add(off, 55, 'recovery'); left -= on + off; }
      cruise(left);
    },

    pyramid(budget) {
      // The biggest ladder that fits (each needs its steps plus 1 min between them).
      const ladders = [[1, 2, 3, 4, 3, 2, 1], [1, 2, 3, 2, 1], [1, 2, 1], [1]];
      const cost = (s) => (s.reduce((x, y) => x + y, 0) + s.length - 1) * 60;
      const steps = ladders.find((s) => cost(s) <= budget) ?? [];
      const peak = [115, 110, 120][v];
      steps.forEach((s, i) => {
        add(s * 60, s <= 2 ? peak : peak - 12, 'work');
        if (i < steps.length - 1) add(60, 55, 'recovery');
      });
      cruise(budget - (steps.length ? cost(steps) : 0));
    },

    sprints(budget) {
      const [on, off] = [[30, 150], [15, 105], [30, 210]][v];
      let left = budget;
      while (left >= on + off) { add(on, 150, 'sprint'); add(off, 58, 'recovery'); left -= on + off; }
      cruise(left);
    },

    cadence(budget) {
      const rpms = [70, 90, 110];
      const ps = [58, 63, 68];
      let left = budget;
      let i = 0;
      while (left >= 180) { add(180, ps[(i + v) % 3], 'drill', { cadence: rpms[(i + v) % 3] }); left -= 180; i++; }
      cruise(left);
    },

    // Tabata-style blocks of short reps with a rest between blocks.
    hiit(budget) {
      const plan = [
        { on: 20, off: 10, reps: 8, pctOn: 145, pctOff: 45, label: 'Tabata' },
        { on: 30, off: 30, reps: 10, pctOn: 130, pctOff: 50, label: '30/30' },
        { on: 40, off: 20, reps: 8, pctOn: 120, pctOff: 50, label: '40/20' },
      ][v];
      const blockS = (plan.on + plan.off) * plan.reps;
      const restS = 180;
      let left = budget;
      let block = 0;
      while (left >= blockS) {
        if (block > 0) {
          if (left < restS + blockS) break;
          add(restS, 55, 'recovery', { name: 'Rest' });
          left -= restS;
        }
        block++;
        for (let r = 1; r <= plan.reps; r++) {
          add(plan.on, plan.pctOn, 'work', { cadence: 100, label: `${plan.label} ${block} · rep ${r}/${plan.reps}` });
          // Rests hold the rep's resistance and just drop the cadence: nobody can
          // swing the resistance up and down every 10 seconds.
          add(plan.off, plan.pctOff, 'recovery', { cadence: 70, hold: true, label: 'Rest' });
        }
        left -= blockS;
      }
      cruise(left);
    },

    // Short-to-medium climbs, descents and flats, varying like real terrain.
    hills(budget) {
      const style = [
        { climb: [60, 180], pct: [80, 94] },
        { climb: [45, 90], pct: [95, 110] }, // punchy
        { climb: [120, 240], pct: [78, 90] }, // long drags
      ][v];
      let left = budget;
      while (left >= style.climb[0] + 120) {
        const climb = Math.min(step(between(...style.climb)), left - 120);
        const pct = between(...style.pct);
        add(climb, pct, 'work', { cadence: pct >= 92 ? 65 : 72, name: 'Hill' });
        const descent = step(between(45, 90));
        add(descent, 56, 'recovery', { cadence: 95, name: 'Descent' });
        const flat = Math.min(step(between(60, 150)), left - climb - descent);
        add(flat, between(66, 74), 'steady', { cadence: 90, name: 'Flat' });
        left -= climb + descent + Math.max(0, flat);
      }
      cruise(left);
    },

    // Long climbs in steps that get steeper, a summit push, then a descent.
    mountain(budget) {
      const style = [
        { start: 80, rise: 4, stepS: 150 },
        { start: 84, rise: 5, stepS: 120 },
        { start: 78, rise: 3, stepS: 180 },
      ][v];
      const approach = 120;
      const summit = 60;
      const descent = 180;
      let left = budget;
      let m = 0;
      while (left >= approach + style.stepS * 2 + summit + descent) {
        const room = left - approach - summit - descent;
        const steps = Math.max(2, Math.min(5, Math.floor(room / style.stepS)));
        m++;
        add(approach, 70, 'steady', { cadence: 88, name: 'Approach' });
        for (let i = 0; i < steps; i++) {
          add(style.stepS, style.start + i * style.rise, 'work', { cadence: Math.max(60, 72 - i * 3), label: `Mountain ${m} · climb ${i + 1}/${steps}` });
        }
        add(summit, 108, 'work', { cadence: 68, label: `Mountain ${m} · summit` });
        add(descent, 55, 'recovery', { cadence: 95, name: 'Descent' });
        left -= approach + steps * style.stepS + summit + descent;
      }
      cruise(left);
    },

    // Steady riding broken up by surges of different lengths.
    fartlek(budget) {
      const style = [
        { gap: [120, 240], surge: [20, 60], pct: [115, 130] },
        { gap: [60, 150], surge: [15, 40], pct: [120, 140] },
        { gap: [180, 300], surge: [30, 75], pct: [110, 120] },
      ][v];
      let left = budget;
      while (left >= style.gap[0] + style.surge[0]) {
        const gap = Math.min(step(between(...style.gap)), left - style.surge[0]);
        add(gap, between(66, 74), 'steady', { cadence: 88, name: 'Ride' });
        left -= gap;
        const surge = Math.min(step(between(...style.surge), 5), left);
        add(surge, between(...style.pct), 'work', { cadence: 98, name: 'Surge' });
        left -= surge;
      }
      cruise(left);
    },

    // Spin-class "songs", one theme each.
    spinclass(budget) {
      const songs = {
        flat: () => [[240, 78, 'steady', { cadence: 95, name: 'Flat road' }]],
        seated: () => [[120, 85, 'work', { cadence: 70, name: 'Seated climb' }], [120, 90, 'work', { cadence: 66, name: 'Seated climb' }]],
        standing: () => [[180, 95, 'work', { cadence: 65, name: 'Standing climb' }], [60, 58, 'recovery', { cadence: 90 }]],
        jumps: () => Array.from({ length: 4 }, () => [[30, 95, 'work', { cadence: 80, name: 'Jump' }], [30, 70, 'steady', { cadence: 85, hold: true, name: 'Settle' }]]).flat(),
        sprints: () => Array.from({ length: 2 }, () => [[30, 150, 'sprint', {}], [90, 55, 'recovery', { cadence: 90 }]]).flat(),
        recover: () => [[180, 55, 'recovery', { cadence: 90 }]],
      };
      const order = [
        ['flat', 'seated', 'jumps', 'standing', 'recover', 'sprints'],
        ['jumps', 'seated', 'sprints', 'recover', 'standing', 'flat'],
        ['seated', 'standing', 'recover', 'jumps', 'sprints', 'flat'],
      ][v];
      let left = budget;
      for (let i = 0; ; i++) {
        const parts = songs[order[i % order.length]]();
        const len = parts.reduce((a, p) => a + p[0], 0);
        if (len > left) break;
        for (const p of parts) add(...p);
        left -= len;
      }
      cruise(left);
    },
  };
  return b;
}

export function workoutFromCode(code) {
  const p = parseWorkoutCode(code);
  return p ? generateWorkout(p.type, p.minutes, p.variant) : null;
}

// Target cadence for each step, spin-class style: heavy climbs are ridden slower
// with more resistance (hills and mountains set their own, down to 60 rpm), short hard efforts and recoveries spin faster. Together
// with the step's power this fixes the resistance for the step.
function targetCadenceFor(s) {
  switch (s.kind) {
    case 'sprint': return 105;
    case 'work': return s.pct >= 110 ? 95 : s.pct >= 100 ? 80 : 85;
    case 'recovery': return 92;
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
    effort: Math.max(1, Math.min(10, Math.round(intensity * 12 - 3))),
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
