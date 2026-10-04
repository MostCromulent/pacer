// The spin class generator.
//
// A class is a run of themed blocks, the way an instructor builds one. Each
// block keeps its format, but its lengths, counts and targets are drawn afresh
// every time it comes up, so no two are quite alike.
//
// - The class has an arc: blocks are ranked by how hard they are and ridden in
//   rising waves, with a recovery between waves.
// - It finishes on one of its hardest blocks, straight into the cool-down.
// - Blocks join up: one that starts from a base effort picks that base near the
//   resistance the last block ended on, to save turning the knob back and forth.
// - Time out of the saddle and time flat out are capped as a share of the class.
// - Blocks can be left out (`exclude`).
// - The low impact class uses only the gentle blocks, eases every effort, caps
//   cadence at 100 rpm and resistance at 50, and never sprints.

/**
 * Every block. The order is the bit order of the "left out" part of a workout
 * code, so only ever add to the end.
 * level: how hard, 1-5. gentle: allowed in the low impact class.
 * finale / lowFinale: can close a class / a low impact class.
 */
export const SPIN_BLOCKS = Object.freeze([
  { id: 'flat', title: 'Flat road', level: 1, gentle: true, always: true },
  { id: 'seated', title: 'Seated climb', level: 2, gentle: true, lowFinale: true },
  { id: 'standing', title: 'Standing climb', level: 3 },
  { id: 'jumps', title: 'Jumps', level: 3 },
  { id: 'sprints', title: 'Sprints', level: 5, finale: true },
  { id: 'ladder', title: 'Standing ladder', level: 4, finale: true },
  { id: 'cadencePush', title: 'Cadence pushes', level: 2, gentle: true },
  { id: 'resistancePush', title: 'Resistance pushes', level: 3, gentle: true, lowFinale: true },
  { id: 'heavyPush', title: 'Heavy pushes', level: 4, finale: true },
  { id: 'creep', title: 'Creeping climb', level: 3, gentle: true, lowFinale: true },
  { id: 'tabata', title: 'Tabata', level: 5, finale: true },
  { id: 'spinups', title: 'Spin-ups', level: 2, gentle: true },
  { id: 'attacks', title: 'Climb with attacks', level: 4, gentle: true, lowFinale: true },
  { id: 'switchbacks', title: 'Switchbacks', level: 4, finale: true },
  { id: 'timeTrial', title: 'Time trial', level: 3, gentle: true, lowFinale: true },
  { id: 'lastPush', title: 'Last push', level: 5, finale: true, finaleOnly: true },
]);

const STAND_SHARE = 0.22; // most of a class that may be ridden out of the saddle
const ALL_OUT_SHARE = 0.08; // most of a class that may be flat out
const LOW_KNOB_CAP = 50;

/** Left-out block ids -> a number for the workout code, and back. */
export function excludeMask(ids = []) {
  return SPIN_BLOCKS.reduce((mask, b, i) => (ids.includes(b.id) && !b.always ? mask | (1 << i) : mask), 0);
}

export function excludeFromMask(mask) {
  return SPIN_BLOCKS.filter((b, i) => mask & (1 << i) && !b.always).map((b) => b.id);
}

/**
 * Fill `budget` seconds with a class, through `add(seconds, pct, kind, opts)`.
 * `rand` is the seeded generator, so the same code gives the same class.
 */
export function buildSpinClass({ add, budget, rand, low = false, exclude = [] }) {
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const int = (lo, hi) => Math.round(between(lo, hi));
  const step = (x, s = 15) => Math.round(x / s) * s;
  const times = (n, make) => Array.from({ length: n }, (_, i) => make(i)).flat();
  const stretch = Math.min(1.8, Math.max(0.85, Math.sqrt(budget / 1200)));

  // Roughly the resistance the rider is on: effort with the cadence taken out.
  let load = null;
  const loadOf = (pct, cadence) => pct / (cadence / 80) ** 1.5;
  /** A base effort for a block: near the last block's resistance, within the block's own range. */
  const near = (lo, hi, cadence) => {
    if (load === null) return between(lo, hi);
    return Math.min(hi, Math.max(lo, load * (cadence / 80) ** 1.5 + between(-2, 2)));
  };

  // Each returns { parts: [[seconds, pct, kind, opts]], rounds? }.
  const makers = {
    flat: () => ({ parts: [[step(between(180, 270), 30), between(74, 80), 'steady', { cadence: int(90, 98), name: 'Flat road' }]] }),
    recover: () => ({ parts: [[step(between(150, 210), 30), 55, 'recovery', { cadence: 90 }]] }),
    seated: () => {
      const cadence = int(68, 73);
      const pct = near(82, 87, cadence);
      return { parts: [[120, pct, 'work', { cadence, name: 'Seated climb' }], [120, pct + between(4, 7), 'work', { cadence: cadence - int(3, 5), name: 'Seated climb' }]] };
    },
    standing: () => ({ parts: [[step(between(150, 210), 30), between(92, 98), 'work', { cadence: int(62, 67), name: 'Standing climb', stand: true }], [60, 58, 'recovery', { cadence: 90 }]] }),
    jumps: () => {
      const rounds = int(3, 5);
      const pct = between(92, 98);
      const up = [20, 30][int(0, 1)];
      return { rounds, parts: times(rounds, () => [[up, pct, 'work', { cadence: 80, name: 'Jump', stand: true }], [30, 70, 'steady', { cadence: 85, hold: true, name: 'Settle' }]]) };
    },
    sprints: () => {
      const rounds = int(2, 3);
      return { rounds, parts: times(rounds, () => [[[20, 30][int(0, 1)], 150, 'sprint', {}], [step(between(75, 105)), 55, 'recovery', { cadence: 90 }]]) };
    },
    // Out of the saddle for longer each time, sitting between at the same resistance.
    ladder: () => {
      const rounds = int(3, 4);
      const first = [20, 30][int(0, 1)];
      const pct = between(95, 101);
      const cadence = int(68, 74);
      return { rounds, parts: times(rounds, (i) => [[first + i * 15, pct, 'work', { cadence, name: 'Stand', stand: true }], [30, 70, 'recovery', { cadence: Math.max(60, cadence - 10), hold: true, name: 'Sit' }]]) };
    },
    // Pushes go up and back several times, changing one thing and holding the other.
    // Cadence: 15-25 rpm faster on the same resistance.
    cadencePush: () => {
      const rounds = int(3, 4);
      const base = int(78, 85);
      const fast = base + int(15, 25);
      const [settle, push] = [step(between(40, 60)), step(between(25, 40), 5)];
      const pct = near(70, 77, base);
      return { rounds, parts: times(rounds, () => [[settle, pct, 'steady', { cadence: base, name: 'Settle' }], [push, pct * 1.3, 'work', { cadence: fast, hold: true, name: 'Cadence push' }]]) };
    },
    // Resistance: about eight to twelve levels heavier at the same cadence.
    resistancePush: () => {
      const rounds = int(3, 4);
      const cadence = int(76, 84);
      const pct = near(68, 75, cadence);
      const more = between(18, 27);
      const [settle, push] = [step(between(40, 60)), step(between(25, 40), 5)];
      return { rounds, parts: times(rounds, () => [[settle, pct, 'steady', { cadence, name: 'Settle' }], [push, pct + more, 'work', { cadence, name: 'Resistance push' }]]) };
    },
    // The same push on a heavy climb, out of the saddle.
    heavyPush: () => {
      const rounds = int(2, 4);
      const cadence = int(64, 68);
      const pct = near(80, 86, cadence);
      const more = between(16, 22);
      const climb = step(between(50, 75));
      return { rounds, parts: times(rounds, () => [[climb, pct, 'work', { cadence, name: 'Heavy climb' }], [30, pct + more, 'work', { cadence: cadence - 2, name: 'Heavy push', stand: true }]]) };
    },
    // A creeping climb: a level or two more resistance every 20 seconds.
    creep: () => {
      const n = int(7, 10);
      const cadence = int(76, 84);
      const from = near(68, 75, cadence);
      const rise = between(3, 4.5);
      return { parts: times(n, (i) => [[20, from + i * rise, 'work', { cadence, creep: true, label: `Creep ${i + 1}/${n}` }]]) };
    },
    // Eight rounds of 20 seconds flat out and 10 seconds off, on one resistance.
    tabata: () => ({ rounds: 8, parts: times(8, (i) => [[20, 145, 'work', { cadence: 100, label: `Tabata ${i + 1}/8` }], [10, 45, 'recovery', { cadence: 70, hold: true, name: 'Rest' }]]) }),
    // The cadence climbs in stages on a light resistance, then settles.
    spinups: () => {
      const rounds = int(2, 3);
      const stage = [15, 20][int(0, 1)];
      const pct = near(58, 64, 80);
      const stages = [[80, 1], [90, 1.2], [100, 1.42], [110, 1.65]];
      return {
        rounds,
        parts: times(rounds, () => [
          ...stages.map(([cadence, more], i) => [stage, pct * more, 'drill', { cadence, hold: i > 0, name: 'Spin-up' }]),
          [40, pct, 'steady', { cadence: 80, hold: true, name: 'Settle' }],
        ]),
      };
    },
    // A long seated climb with a short surge every minute.
    attacks: () => {
      const rounds = int(3, 5);
      const cadence = int(68, 72);
      const pct = near(84, 90, cadence);
      return { rounds, parts: times(rounds, () => [[45, pct, 'work', { cadence, name: 'Climb' }], [15, pct * 1.25, 'work', { cadence: cadence + 12, hold: true, name: 'Attack' }]]) };
    },
    // In and out of the saddle every 30 seconds on the same heavy resistance.
    switchbacks: () => {
      const rounds = int(3, 4);
      const cadence = int(66, 70);
      const pct = near(90, 95, cadence);
      return { rounds, parts: times(rounds, () => [[30, pct, 'work', { cadence, name: 'Switchback' }], [30, pct * 0.92, 'work', { cadence: cadence - 5, hold: true, name: 'Stand up', stand: true }]]) };
    },
    // One hard, steady, seated effort.
    timeTrial: () => ({ parts: [[step(between(240, 360), 30), between(92, 97), 'work', { cadence: int(88, 94), name: 'Time trial' }]] }),
    // A single flat-out minute to finish on.
    lastPush: () => ({ parts: [[60, 150, 'sprint', { name: 'Last push' }]] }),
  };

  const title = (id) => SPIN_BLOCKS.find((b) => b.id === id)?.title ?? 'Recovery';
  const allowed = SPIN_BLOCKS.filter((b) => b.always || (!exclude.includes(b.id) && (!low || b.gentle)));

  // Low impact: efforts above an easy pace are pulled 40% of the way back
  // towards it, with a ceiling on cadence and on resistance.
  const eased = ([dur, pct, kind, opts]) => (low
    ? [dur, pct > 60 ? 60 + (pct - 60) * 0.6 : pct, kind, { ...opts, cadence: Math.min(100, opts.cadence ?? 100), knobCap: LOW_KNOB_CAP }]
    : [dur, pct, kind, opts]);

  /** Build a block's steps: sized, eased, and tagged with the block they belong to. */
  const build = (id) => {
    const { parts, rounds } = makers[id]();
    const steps = parts.map(([dur, ...rest]) => eased([dur >= 120 ? step(dur * stretch, 30) : dur, ...rest]));
    return { id, rounds, steps };
  };
  const cost = (steps) => ({
    len: steps.reduce((a, p) => a + p[0], 0),
    stand: steps.reduce((a, p) => a + (p[3].stand ? p[0] : 0), 0),
    allOut: steps.reduce((a, p) => a + (p[2] === 'sprint' || p[1] >= 130 ? p[0] : 0), 0),
  });

  let standLeft = budget * STAND_SHARE;
  let allOutLeft = Math.max(60, budget * ALL_OUT_SHARE);
  let lastKind = null;
  const emit = ({ id, rounds, steps }) => {
    steps.forEach(([dur, pct, kind, opts], i) => {
      add(dur, pct, kind, { ...opts, block: title(id), ...(i === 0 ? { blockStart: true, ...(rounds ? { rounds } : {}) } : {}) });
      if (kind !== 'recovery' && !opts.hold && opts.cadence) load = loadOf(pct, opts.cadence);
    });
    const c = cost(steps);
    standLeft -= c.stand;
    allOutLeft -= c.allOut;
    lastKind = steps.at(-1)[2];
    return c.len;
  };

  // The finale is set aside first, and everything else is fitted in before it.
  const closers = allowed.filter((b) => (low ? b.lowFinale : b.finale));
  const closer = closers.length ? closers[Math.floor(rand() * closers.length)] : null;
  let finale = null;
  if (closer) {
    const made = build(closer.id);
    while (made.steps.length > 1 && made.steps.at(-1)[2] === 'recovery') made.steps.pop(); // the cool-down is the recovery
    if (budget >= cost(made.steps).len + 240) finale = made;
  }
  if (finale) {
    // A big finale may use a whole allowance by itself; the rest of the class
    // then simply has none of that kind of work.
    const c = cost(finale.steps);
    standLeft = Math.max(0, standLeft - c.stand);
    allOutLeft = Math.max(0, allOutLeft - c.allOut);
  }

  // One pass: as many blocks as will roughly fit, picked at random and ridden
  // in waves of two or three that each build from easy to hard.
  const arc = (first, room) => {
    const all = allowed
      .filter((b) => !b.always && !b.finaleOnly && b.id !== finale?.id)
      .map((b) => ({ id: b.id, level: b.level, pick: rand(), rank: b.level + rand() * 0.9 }));
    const fits = Math.max(2, Math.round(room / 250));
    const pool = all.sort((p, q) => p.pick - q.pick).slice(0, fits).sort((p, q) => p.rank - q.rank);
    const waves = Array.from({ length: Math.ceil(pool.length / 3) }, () => []);
    pool.forEach((b, i) => waves[i % waves.length].push(b));
    const order = first ? ['flat'] : [];
    waves.forEach((wave, w) => {
      if (w > 0 || !first) order.push('recover');
      for (const b of wave) {
        order.push(b.id);
        if (b.level >= 5) order.push('recover');
      }
    });
    if (!pool.length && !first) order.push('flat');
    return order;
  };

  let left = finale ? budget - cost(finale.steps).len : budget;
  // Keep making passes until several in a row add nothing: one random handful
  // of blocks may all be too long, or over a cap, when the next would fit.
  for (let pass = 0, empty = 0; pass < 40 && empty < 5; pass++) {
    let added = 0;
    for (const id of arc(pass === 0, left)) {
      if (id === 'recover' && (lastKind === 'recovery' || lastKind === null)) continue;
      const made = build(id);
      const c = cost(made.steps);
      if (c.len > left || c.stand > standLeft || c.allOut > allOutLeft) continue;
      left -= emit(made);
      added += 1;
    }
    empty = added ? 0 : empty + 1;
  }
  if (left > 0) add(left, 62, 'steady', { name: 'Cruise', ...(low ? { knobCap: LOW_KNOB_CAP } : {}) });
  if (finale) emit(finale);
}
