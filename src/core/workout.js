// Workout generation. Rule-based and deterministic: the same code always
// produces the same workout, which is what makes ghost races fair. "Natural"
// styles use a seeded random generator, so they vary like a real ride but are
// still identical every time for the same code.

export const TYPES = [
  { id: 'endurance', group: 'Steady', name: 'Endurance', hint: 'Steady, chatty pace', code: 'END' },
  { id: 'recovery', group: 'Steady', name: 'Recovery spin', hint: 'Easy legs, light resistance', code: 'REC' },
  { id: 'lowimpact', group: 'Steady', name: 'Low impact', hint: 'Seated, moderate, gentle rises', code: 'LOW' },
  { id: 'tempo', group: 'Steady', name: 'Sweet spot', hint: 'Long, hard blocks', code: 'SST' },
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
  { id: 'spinclass', group: 'Spin class', name: 'Spin class', hint: 'Climbs, pushes, jumps and sprints in short blocks', code: 'SPN' },
  { id: 'surprise', group: 'Mixed', name: 'Mix it up', hint: 'A natural ride, then intervals', code: 'MIX' },
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

export function workoutCode(type, minutes, variant) {
  const t = TYPES.find((x) => x.id === type);
  if (!t) throw new Error(`Unknown workout type: ${type}`);
  return `${t.code}-${minutes}-${variantCode(variant)}`;
}

export function parseWorkoutCode(code) {
  const m = /^([A-Z]{3})-(\d{1,3})-([A-Z0-9]{3})$/.exec(String(code).trim().toUpperCase());
  if (!m) return null;
  const type = TYPES.find((x) => x.code === m[1]);
  const named = VARIANT_CODES.indexOf(m[3]);
  const variant = named >= 0 ? named : 3 + parseInt(m[3], 36);
  const minutes = Number(m[2]);
  if (!type || minutes < 10 || minutes > 120) return null;
  return { type: type.id, minutes, variant };
}

/**
 * Build a workout.
 * Segments: { start, dur (seconds), pct (% of baseline), kind, cadence, name?, label }
 * kind: 'warmup' | 'work' | 'recovery' | 'steady' | 'sprint' | 'drill' | 'cooldown'
 * `name` (optional) is what the step is called in the app ("Hill", "Rep", "Descent").
 * `hold: true` means "keep the previous step's resistance, change only cadence".
 * `creep: true` marks one step of a creeping climb, where only the resistance moves.
 * `position` is 'seated' or 'standing' (out of the saddle); steps are seated
 * unless they are built with `stand: true`.
 */
export function generateWorkout(type, minutes, variant = 0) {
  variant = Math.max(0, Math.floor(variant));
  const v = variant % 3; // which of a ride's three styles to use
  const segs = [];
  // All durations in whole seconds, so the parts always add up exactly.
  const add = (sec, pct, kind, opts = {}) => {
    const dur = Math.round(sec);
    if (dur <= 0) return;
    segs.push({ dur, pct: Math.round(pct), kind, ...opts });
  };
  const rand = seeded(`${type}-${minutes}-${variant}`);

  const warm = Math.min(5, Math.max(3, Math.round(minutes * 0.13)));
  const cool = Math.min(5, Math.max(3, Math.round(minutes * 0.1)));
  const main = (minutes - warm - cool) * 60;

  const gentle = type === 'recovery' || type === 'lowimpact';
  const warmTop = gentle ? 58 : 72;
  for (let i = 0; i < warm; i++) add(60, 45 + ((i + 1) / warm) * (warmTop - 45), 'warmup');

  const builders = makeBuilders(add, v, rand, variant >= 3);
  if (type === 'surprise') {
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

  const name = type === 'surprise' ? MIXES[v].name : TYPES.find((x) => x.id === type)?.name ?? type;
  const workout = {
    code: workoutCode(type, minutes, variant),
    type,
    name,
    minutes,
    variant,
    totalS: t,
    segments: segs,
  };
  workout.gates = computeGates(workout);
  labelSteps(workout);
  return workout;
}

const EASY_SPELL_S = 180;

/**
 * The main-set builders. Each takes a budget in seconds, spends what it can,
 * and fills any remainder with easy cruising, so the total is always exact.
 *
 * A longer ride gets both longer efforts and more of them: lengths grow with
 * the square root of the time available (`stretch`), and the count makes up the
 * rest. Once there are more than five repeats they are grouped into sets with
 * an easy spell between, so a long ride has a shape.
 */
function makeBuilders(add, v, rand, shuffled = false) {
  const cruise = (sec) => add(sec, 62, 'steady', { name: 'Cruise' });
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const step = (x, s = 15) => Math.round(x / s) * s;
  const stretch = (budget) => Math.min(1.8, Math.max(0.85, Math.sqrt(budget / 1200)));

  /** How many repeats of `repS` seconds fit, and in how many sets. */
  const planSets = (budget, repS) => {
    let n = Math.floor(budget / repS);
    let sets = 1;
    if (n > 5) {
      sets = Math.ceil(n / 4);
      n = Math.floor((budget - (sets - 1) * EASY_SPELL_S) / repS);
    }
    return { n, sets };
  };

  /** Fill the budget with repeats of `repS` seconds, in sets. Returns the seconds used. */
  const inSets = (budget, repS, emit) => {
    const { n, sets } = planSets(budget, repS);
    for (let i = 0; i < sets; i++) {
      const inThisSet = Math.floor(n / sets) + (i < n % sets ? 1 : 0);
      for (let r = 0; r < inThisSet; r++) emit();
      if (i < sets - 1) add(EASY_SPELL_S, 60, 'steady', { name: 'Easy spell' });
    }
    return n * repS + (sets - 1) * EASY_SPELL_S;
  };
  const clampInt = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(x)));

  const b = {
    endurance(budget) {
      const blk = step([5, 6, 4][v] * 60 * stretch(budget), 60);
      const ps = [[65, 72], [68, 74], [62, 70]][v];
      let left = budget;
      let i = 0;
      while (left >= blk) { add(blk, ps[i % 2], 'steady'); left -= blk; i++; }
      add(left, ps[0], 'steady');
    },

    recovery(budget) {
      const blk = step(300 * stretch(budget), 60);
      const ps = [[55, 60], [52, 58], [58, 62]][v];
      let left = budget;
      let i = 0;
      while (left >= blk) { add(blk, ps[i % 2], 'steady', { cadence: 95, name: 'Easy spin' }); left -= blk; i++; }
      add(left, ps[0], 'steady', { cadence: 95, name: 'Easy spin' });
    },

    // Seated throughout at a moderate effort: flat road broken by gentle rises,
    // never hard enough for a sprint gate.
    lowimpact(budget) {
      const k = stretch(budget);
      const [flatS, riseS] = [[180, 120], [180, 180], [120, 240]][v].map((x) => step(x * k, 30));
      let left = budget;
      while (left >= flatS + riseS) {
        add(flatS, between(60, 66), 'steady', { cadence: Math.round(between(80, 86)), name: 'Flat road' });
        add(riseS, between(74, 82), 'steady', { cadence: Math.round(between(70, 76)), name: 'Gentle rise' });
        left -= flatS + riseS;
      }
      add(left, 62, 'steady', { cadence: 82, name: 'Flat road' });
    },

    // One effort from start to finish: each step a little harder than the last,
    // with no recoveries, ending at the top.
    progression(budget) {
      const top = [100, 95, 105][v];
      const stepS = [180, 240, 120][v] * stretch(budget);
      const n = Math.max(3, Math.min(12, Math.round(budget / stepS)));
      const each = step(budget / n);
      for (let i = 0; i < n; i++) {
        const pct = 65 + (i / (n - 1)) * (top - 65);
        const dur = i === n - 1 ? budget - each * (n - 1) : each;
        add(dur, pct, pct >= 91 ? 'work' : 'steady', { cadence: Math.round(84 + (i / (n - 1)) * 8), label: `Build ${i + 1}/${n}` });
      }
    },

    // The same hill again and again, slow and heavy, with a descent between.
    climbs(budget) {
      const k = stretch(budget);
      const [base, off] = [[240, 150], [300, 180], [180, 120]][v].map((x) => step(x * k, 30));
      // Time that wouldn't fit another repeat makes each climb a little longer.
      const { n, sets } = planSets(budget, base + off);
      const spare = budget - n * (base + off) - (sets - 1) * EASY_SPELL_S;
      const on = base + (n ? Math.floor(spare / n / 15) * 15 : 0);
      const pct = [92, 88, 98][v];
      const cadence = [64, 66, 62][v];
      cruise(budget - inSets(budget, on + off, () => {
        add(on, pct, 'work', { cadence, stand: pct >= 98 });
        add(off, 55, 'recovery', { cadence: 92, name: 'Descent' });
      }));
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
      const [on, off] = [[3, 2], [4, 3], [2, 1]][v].map((m) => step(m * 60 * stretch(budget), 30));
      cruise(budget - inSets(budget, on + off, () => { add(on, 105, 'work'); add(off, 55, 'recovery'); }));
    },

    pyramid(budget) {
      // The biggest ladder that fits (each needs its steps plus 1 min between
      // them), then another after an easy spell, for as long as one fits.
      const ladders = [[1, 2, 3, 4, 3, 2, 1], [1, 2, 3, 2, 1], [1, 2, 1], [1]];
      const cost = (s) => (s.reduce((x, y) => x + y, 0) + s.length - 1) * 60;
      const peak = [115, 110, 120][v];
      let left = budget;
      for (let n = 0; ; n++) {
        const room = n ? left - EASY_SPELL_S : left;
        const steps = ladders.find((s) => cost(s) <= room && (n === 0 || s.length > 1));
        if (!steps) break;
        if (n) add(EASY_SPELL_S, 60, 'steady', { name: 'Easy spell' });
        steps.forEach((s, i) => {
          add(s * 60, s <= 2 ? peak : peak - 12, 'work');
          if (i < steps.length - 1) add(60, 55, 'recovery');
        });
        left = room - cost(steps);
      }
      cruise(left);
    },

    sprints(budget) {
      // Sprints stay the same length however long the ride; there are just more sets.
      const [on, off] = [[30, 150], [15, 105], [30, 210]][v];
      cruise(budget - inSets(budget, on + off, () => { add(on, 150, 'sprint'); add(off, 58, 'recovery'); }));
    },

    cadence(budget) {
      const rpms = [70, 90, 110];
      const ps = [58, 63, 68];
      const blk = step(180 * stretch(budget), 30);
      let left = budget;
      let i = 0;
      while (left >= blk) { add(blk, ps[(i + v) % 3], 'drill', { cadence: rpms[(i + v) % 3] }); left -= blk; i++; }
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
      const k = stretch(budget);
      let left = budget;
      while (left >= style.climb[0] * k + 120) {
        const climb = Math.min(step(between(...style.climb) * k), left - 120);
        const pct = between(...style.pct);
        // No two hills alike: steeper ones are ridden slower, and descents and
        // flats vary a little too.
        add(climb, pct, 'work', { cadence: clampInt(72 - (pct - 80) / 3 + between(-2, 2), 60, 76), name: 'Hill', stand: pct >= 100 });
        const descent = step(between(45, 90));
        add(descent, between(50, 60), 'recovery', { cadence: Math.round(between(90, 98)), name: 'Descent' });
        const flat = Math.min(step(between(60, 150) * k), left - climb - descent);
        add(flat, between(66, 74), 'steady', { cadence: Math.round(between(86, 92)), name: 'Flat' });
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
      const stepS = step(style.stepS * stretch(budget), 30);
      const approach = 120;
      const summit = 60;
      const descent = 180;
      // Share the time evenly between the mountains, so the last one isn't
      // squeezed out and replaced by a long cruise.
      const fixed = approach + summit + descent;
      const count = Math.max(1, Math.round(budget / (fixed + 4 * stepS)));
      const each = Math.floor(budget / count);
      let left = budget;
      for (let m = 1; m <= count && each >= fixed + stepS * 2; m++) {
        const steps = Math.min(6, Math.floor((each - fixed) / stepS));
        // Time that doesn't fill another step goes into a longer ride in.
        const valley = Math.min(240, step(each - fixed - steps * stepS) - 15);
        const rideIn = approach + Math.max(0, valley);
        add(rideIn, between(66, 72), 'steady', { cadence: 88, name: 'Approach' });
        // Each mountain's steps still rise, but unevenly, as real gradients do.
        for (let i = 0; i < steps; i++) {
          add(stepS, style.start + i * style.rise + between(-1.5, 1.5), 'work', { cadence: clampInt(72 - i * 3 + between(-1, 1), 60, 76), label: `Mountain ${m} · climb ${i + 1}/${steps}` });
        }
        add(summit, between(104, 112), 'work', { cadence: Math.round(between(65, 70)), label: `Mountain ${m} · summit`, stand: true });
        add(descent, between(52, 58), 'recovery', { cadence: Math.round(between(92, 98)), name: 'Descent' });
        left -= rideIn + steps * stepS + summit + descent;
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
      const k = stretch(budget);
      let left = budget;
      while (left >= style.gap[0] + style.surge[0]) {
        const gap = Math.min(step(between(...style.gap) * k), left - style.surge[0]);
        add(gap, between(66, 74), 'steady', { cadence: Math.round(between(85, 91)), name: 'Ride' });
        left -= gap;
        const surge = Math.min(step(between(...style.surge) * Math.sqrt(k), 5), left);
        add(surge, between(...style.pct), 'work', { cadence: Math.round(between(94, 102)), name: 'Surge' });
        left -= surge;
      }
      cruise(left);
    },

    // A spin class is a run of themed blocks. Each block keeps its format, but
    // its lengths, counts and targets are drawn afresh every time it comes up,
    // so no two are quite alike.
    spinclass(budget) {
      const int = (lo, hi) => Math.round(between(lo, hi));
      const times = (n, make) => Array.from({ length: n }, (_, i) => make(i)).flat();
      const blocks = {
        flat: () => [[step(between(180, 270), 30), between(74, 80), 'steady', { cadence: int(90, 98), name: 'Flat road' }]],
        seated: () => {
          const cadence = int(68, 73);
          return [[120, between(82, 87), 'work', { cadence, name: 'Seated climb' }], [120, between(88, 93), 'work', { cadence: cadence - int(3, 5), name: 'Seated climb' }]];
        },
        standing: () => [[step(between(150, 210), 30), between(92, 98), 'work', { cadence: int(62, 67), name: 'Standing climb', stand: true }], [60, 58, 'recovery', { cadence: 90 }]],
        jumps: () => {
          const pct = between(92, 98);
          const up = [20, 30][int(0, 1)];
          return times(int(3, 5), () => [[up, pct, 'work', { cadence: 80, name: 'Jump', stand: true }], [30, 70, 'steady', { cadence: 85, hold: true, name: 'Settle' }]]);
        },
        sprints: () => times(int(2, 3), () => [[[20, 30][int(0, 1)], 150, 'sprint', {}], [step(between(75, 105)), 55, 'recovery', { cadence: 90 }]]),
        // Out of the saddle for longer each time, sitting between at the same resistance.
        ladder: () => {
          const first = [20, 30][int(0, 1)];
          const pct = between(95, 101);
          const cadence = int(68, 74);
          return times(int(3, 4), (i) => [[first + i * 15, pct, 'work', { cadence, name: 'Stand', stand: true }], [30, 70, 'recovery', { cadence: Math.max(60, cadence - 10), hold: true, name: 'Sit' }]]);
        },
        recover: () => [[step(between(150, 210), 30), 55, 'recovery', { cadence: 90 }]],
        // Pushes go up and back several times, changing one thing and holding the other.
        // Cadence: 15-25 rpm faster on the same resistance.
        cadencePush: () => {
          const base = int(78, 85);
          const fast = base + int(15, 25);
          const [settle, push] = [step(between(40, 60)), step(between(25, 40), 5)];
          const pct = between(70, 77);
          return times(int(3, 4), () => [[settle, pct, 'steady', { cadence: base, name: 'Settle' }], [push, pct * 1.3, 'work', { cadence: fast, hold: true, name: 'Cadence push' }]]);
        },
        // Resistance: about eight to twelve levels heavier at the same cadence.
        resistancePush: () => {
          const cadence = int(76, 84);
          const pct = between(68, 75);
          const more = between(18, 27);
          const [settle, push] = [step(between(40, 60)), step(between(25, 40), 5)];
          return times(int(3, 4), () => [[settle, pct, 'steady', { cadence, name: 'Settle' }], [push, pct + more, 'work', { cadence, name: 'Resistance push' }]]);
        },
        // The same push on a heavy climb, out of the saddle.
        heavyPush: () => {
          const cadence = int(64, 68);
          const pct = between(80, 86);
          const more = between(16, 22);
          const climb = step(between(50, 75));
          return times(int(2, 4), () => [[climb, pct, 'work', { cadence, name: 'Heavy climb' }], [30, pct + more, 'work', { cadence: cadence - 2, name: 'Heavy push', stand: true }]]);
        },
        // A creeping climb: a level or two more resistance every 20 seconds.
        creep: () => {
          const n = int(7, 10);
          const from = between(68, 75);
          const rise = between(3, 4.5);
          const cadence = int(76, 84);
          return times(n, (i) => [[20, from + i * rise, 'work', { cadence, creep: true, label: `Creep ${i + 1}/${n}` }]]);
        },
      };
      const standard = [
        ['flat', 'cadencePush', 'seated', 'creep', 'recover', 'ladder', 'jumps', 'recover', 'resistancePush', 'standing', 'recover', 'heavyPush', 'sprints'],
        ['jumps', 'resistancePush', 'recover', 'seated', 'creep', 'sprints', 'recover', 'ladder', 'flat', 'cadencePush', 'heavyPush', 'recover', 'standing'],
        ['seated', 'heavyPush', 'recover', 'cadencePush', 'jumps', 'creep', 'recover', 'sprints', 'flat', 'ladder', 'resistancePush', 'standing'],
      ][v];
      // A random class: every block once, in a shuffled order that opens gently
      // and recovers after every second hard block.
      const shuffledOrder = () => {
        const pool = Object.keys(blocks).filter((b) => b !== 'recover' && b !== 'flat');
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const out = ['flat'];
        pool.forEach((b, i) => {
          out.push(b);
          if (i % 2 === 1) out.push('recover');
        });
        return out;
      };
      // The class finishes on its hardest block, straight into the cool-down.
      // It is set aside first, and everything else is fitted in before it.
      const FINALES = ['sprints', 'heavyPush', 'ladder'];
      const finaleName = FINALES[shuffled ? Math.floor(rand() * FINALES.length) : v];
      const finale = blocks[finaleName]();
      while (finale.length > 1 && finale.at(-1)[2] === 'recovery') finale.pop(); // the cool-down is the recovery
      const finaleS = finale.reduce((a, p) => a + p[0], 0);
      const hasFinale = budget >= finaleS + 240;

      const order = (shuffled ? shuffledOrder() : standard).filter((name) => !hasFinale || name !== finaleName);
      const k = stretch(budget);
      let left = hasFinale ? budget - finaleS : budget;
      let lastKind = null;
      for (let i = 0; ; i++) {
        const name = order[i % order.length];
        // No need for a recovery block straight after a block that ends in one.
        if (name === 'recover' && lastKind === 'recovery') continue;
        const parts = blocks[name]().map(([dur, ...rest]) => [dur >= 120 ? step(dur * k, 30) : dur, ...rest]);
        const len = parts.reduce((a, p) => a + p[0], 0);
        if (len > left) break;
        for (const p of parts) add(...p);
        lastKind = parts.at(-1)[2];
        left -= len;
      }
      cruise(left);
      if (hasFinale) for (const p of finale) add(...p);
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
