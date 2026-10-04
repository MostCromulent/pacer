// The spin class generator.
//
// A class is a run of themed blocks, the way an instructor builds one. Each
// block keeps its format, but its lengths, counts and targets are drawn afresh
// every time it comes up, so no two are quite alike.
//
// Nothing about a block is labelled by hand. Once a block is built, how hard
// it is, how much of it is out of the saddle or flat out, and how much rest it
// earns are all measured from its steps. The class is then planned from those
// measurements:
//
// - Several classes are drafted and the one closest to the target is kept: an
//   average effort and a share of hard riding that are the same for every
//   class, so two versions of a class are about as hard as each other.
// - It finishes on its hardest block, straight into the cool-down. Nothing
//   before the finale is harder than the finale.
// - The blocks before it are laid out on a curve that builds across the whole
//   class in waves: each wave climbs, then drops back to start a little higher
//   than the last.
// - A block is followed by a rest sized by how much it took out of the rider.
//   Blocks of repeated pushes always get one, so two never run back to back.
// - A longer class has more blocks, and more rounds in them.
// - Time left over lengthens the steady parts of the class a little, instead
//   of becoming a spell of riding with nothing to do.
// - Blocks join up: one that starts from a base effort picks that base near the
//   resistance the last block ended on, to save turning the dial back and forth.
// - A step that holds the resistance and changes only the cadence is planned at
//   the effort that really comes to, since watts rise steeply with cadence.
// - Time out of the saddle and time flat out are capped as a share of the class.
// - Blocks can be left out (`exclude`).
// - The low impact class is the same class kept gentle: every effort is eased,
//   cadence stays between 75 and 100 rpm and resistance at 50 or less, and
//   nobody leaves the saddle. Blocks that can be ridden that way build a gentle form
//   of themselves; the rest are left out.

import { clamp, draws, roundTo, seededRandom, stretchFor } from './util.js';

/**
 * Every block. The order is the bit order of the "left out" part of a workout
 * code, so only ever add to the end.
 * always: opens every class and can't be left out.
 * gentle: has a form for the low impact class (a string is its name there).
 * finaleOnly: only makes sense as the last block of a class.
 */
export const SPIN_BLOCKS = Object.freeze([
  { id: 'flat', title: 'Flat road', always: true, gentle: true },
  { id: 'seated', title: 'Seated climb', gentle: true },
  { id: 'standing', title: 'Standing climb' },
  { id: 'jumps', title: 'Jumps' },
  { id: 'sprints', title: 'Sprints', gentle: 'Surges' },
  { id: 'ladder', title: 'Standing ladder', gentle: 'Seated ladder' },
  { id: 'cadencePush', title: 'Cadence pushes', gentle: true },
  { id: 'resistancePush', title: 'Resistance pushes', gentle: true },
  { id: 'heavyPush', title: 'Heavy pushes', gentle: true },
  { id: 'creep', title: 'Creeping climb', gentle: true },
  { id: 'tabata', title: 'Tabata' },
  { id: 'spinups', title: 'Spin-ups', gentle: true },
  { id: 'attacks', title: 'Climb with attacks', gentle: true },
  { id: 'switchbacks', title: 'Switchbacks' },
  { id: 'timeTrial', title: 'Time trial', gentle: true },
  { id: 'lastPush', title: 'Last push', finaleOnly: true },
]);

/** What a block is called: its gentle form may have its own name. */
export function spinBlockTitle(block, low = false) {
  return low && typeof block.gentle === 'string' ? block.gentle : block.title;
}

// What a class aims for, as shares of its main set.
const TARGET_MEAN_PCT = 80; // average effort, recoveries included
const TARGET_HARD_SHARE = 0.2; // riding at HARD_PCT or more
const STAND_SHARE = 0.22; // most of a class that may be ridden out of the saddle
const ALL_OUT_SHARE = 0.08; // most of a class that may be flat out
const FINALE_SHARE = 0.4; // the finale is drawn from this share of the blocks, hardest first
const DRAFTS = 16; // classes drafted before the closest to the target is kept
// What counts as one noticeable miss when drafts are compared.
const MEAN_MISS = 2; // points of average effort
const HARD_MISS = 0.04; // share of hard riding
const LEFT_MISS_S = 45; // seconds left unfilled
const UPSTAGED_MISS = 10; // a block before the finale turning out harder than it

// How a block is measured.
const HARD_PCT = 95;
const ALL_OUT_PCT = 130;
const EASY_PCT = 72; // effort above this is what a rest is earned by
const PEAK_WEIGHT = 0.3; // how far a block's hardest step lifts it above its average

// Rests. A block earns a second of rest for every REST_EARNED effort-seconds above easy.
const REST_EARNED = 47;
const SHORTEST_REST_S = 60; // less than this isn't worth stopping for
const LONGEST_REST_S = 150;
const RECOVERY_FROM_S = 90; // a rest this long is a proper recovery; a shorter one is flat road
const BETWEEN_ROUNDS_S = 75; // the least rest after a block of repeated pushes, or one that ends hard
const OWN_REST_S = 60; // a block ending on a recovery this long has already rested
const LEAD_IN_S = 90; // the least easy riding before the finale

// Sizing.
const SHORTEST_BODY_S = 180; // a finale must leave at least this for the rest of the class
const MOST_EXTRA_ROUNDS = 1.3; // a long class has up to this many times the rounds
const MOST_STRETCH = 0.25; // how much longer left-over time may make a steady step
const LOW_RESISTANCE_CAP = 50;
const LOW_CADENCES = [75, 100]; // a gentle class neither grinds nor spins out
// Watts rise with about this power of cadence at a fixed resistance. Bikes
// differ a little; this is only for planning how hard a held step is.
const CADENCE_POWER = 1.6;

/** Left-out block ids -> a number for the workout code, and back. */
export function excludeMask(ids = []) {
  return SPIN_BLOCKS.reduce((mask, b, i) => (ids.includes(b.id) && !b.always ? mask | (1 << i) : mask), 0);
}

export function excludeFromMask(mask) {
  return SPIN_BLOCKS.filter((b, i) => mask & (1 << i) && !b.always).map((b) => b.id);
}

/**
 * The format of every block. Each returns { parts: [[seconds, pct, kind, opts]], rounds? }.
 * `between` and `int` draw from the block's own random numbers, `near` picks a
 * base effort close to the last block's resistance, `reps` draws a number of
 * rounds that grows with the class, and `low` asks for the gentle form.
 */
function blockMakers({ between, int, near, reps, low }) {
  const step = roundTo;
  const times = (n, make) => Array.from({ length: n }, (_, i) => make(i)).flat();
  return {
    flat: () => ({ parts: [[step(between(120, 180), 30), between(74, 80), 'steady', { cadence: int(90, 98), name: 'Flat road', most: 180 }]] }),
    seated: () => {
      const cadence = int(68, 73);
      const pct = near(82, 87, cadence);
      return { parts: [[120, pct, 'work', { cadence, name: 'Seated climb' }], [120, pct + between(4, 7), 'work', { cadence: cadence - int(3, 5), name: 'Seated climb' }]] };
    },
    standing: () => ({ parts: [[step(between(120, 165), 15), between(92, 98), 'work', { cadence: int(62, 67), name: 'Standing climb', stand: true, most: 180 }], [60, 55, 'recovery', { cadence: 75 }]] }),
    // Up out of the saddle and back down on one resistance, sitting at an easier cadence.
    jumps: () => {
      const rounds = reps(3, 5);
      const pct = between(86, 92);
      const up = [20, 30][int(0, 1)];
      return { rounds, parts: times(rounds, () => [[up, pct, 'work', { cadence: 80, name: 'Jump', stand: true }], [30, pct, 'steady', { cadence: 72, hold: true, name: 'Settle' }]]) };
    },
    // Flat out, with a recovery after each. Gentle: a fast seated surge instead.
    sprints: () => {
      if (low) {
        const rounds = reps(3, 4);
        const [on, off] = [step(between(30, 40), 5), step(between(45, 60))];
        return { rounds, parts: times(rounds, () => [[on, 115, 'work', { cadence: 100, name: 'Surge' }], [off, 55, 'recovery', { cadence: 75 }]]) };
      }
      const rounds = reps(2, 3);
      return { rounds, parts: times(rounds, () => [[[20, 30][int(0, 1)], 150, 'sprint', {}], [step(between(60, 75)), 55, 'recovery', { cadence: 75 }]]) };
    },
    // Out of the saddle for longer each time, taking some resistance off to
    // sit between. Gentle: the same ladder of pushes, seated.
    ladder: () => {
      const rounds = reps(3, 4);
      const first = [20, 30][int(0, 1)];
      const pct = between(95, 101);
      const cadence = int(68, 74);
      return { rounds, parts: times(rounds, (i) => [[first + i * 15, pct, 'work', { cadence, name: low ? 'Push' : 'Stand', stand: true }], [30, 68, 'recovery', { cadence: 75, name: low ? 'Settle' : 'Sit' }]]) };
    },
    // Pushes go up and back several times, changing one thing and holding the other.
    // Cadence: 12-20 rpm faster on the same resistance.
    cadencePush: () => {
      const rounds = reps(3, 4);
      const base = int(78, 85);
      const fast = base + int(12, 20);
      const [settle, push] = [step(between(40, 60)), step(between(25, 40), 5)];
      const pct = near(68, 74, base);
      return { rounds, parts: times(rounds, () => [[settle, pct, 'steady', { cadence: base, name: 'Settle' }], [push, pct, 'work', { cadence: fast, hold: true, name: 'Cadence push' }]]) };
    },
    // Resistance: about eight to twelve levels heavier at the same cadence.
    resistancePush: () => {
      const rounds = reps(3, 4);
      const cadence = int(76, 84);
      const pct = near(68, 75, cadence);
      const more = between(18, 27);
      const [settle, push] = [step(between(40, 60)), step(between(25, 40), 5)];
      return { rounds, parts: times(rounds, () => [[settle, pct, 'steady', { cadence, name: 'Settle' }], [push, pct + more, 'work', { cadence, name: 'Resistance push' }]]) };
    },
    // The same push on a heavy climb, out of the saddle (seated in the gentle form).
    heavyPush: () => {
      const rounds = reps(2, 4);
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
    // Eight rounds of 20 seconds very hard and 10 seconds of easy legs, on one resistance.
    tabata: () => ({ rounds: 8, parts: times(8, (i) => [[20, 125, 'work', { cadence: 100, label: `Tabata ${i + 1}/8` }], [10, 125, 'recovery', { cadence: 65, hold: true, name: 'Rest' }]]) }),
    // The cadence climbs in stages on a light resistance, then settles.
    spinups: () => {
      const rounds = reps(2, 3);
      const stage = [15, 20][int(0, 1)];
      const pct = near(58, 64, 80);
      const stages = [[80, 1], [90, 1.2], [100, 1.42], [110, 1.65]];
      return {
        rounds,
        parts: times(rounds, (round) => [
          ...stages.map(([cadence, more], i) => [stage, pct * more, 'drill', { cadence, hold: i > 0, label: `Spin-up ${round + 1}/${rounds}` }]),
          [40, pct, 'steady', { cadence: 80, hold: true, name: 'Settle' }],
        ]),
      };
    },
    // A long seated climb with a short surge every minute.
    attacks: () => {
      const rounds = reps(3, 5);
      const cadence = int(68, 72);
      const pct = near(84, 90, cadence);
      return { rounds, parts: times(rounds, () => [[45, pct, 'work', { cadence, name: 'Climb' }], [15, pct * 1.25, 'work', { cadence: cadence + 12, hold: true, name: 'Attack' }]]) };
    },
    // In and out of the saddle every 30 seconds on the same heavy resistance.
    switchbacks: () => {
      const rounds = reps(3, 4);
      const cadence = int(66, 70);
      const pct = near(90, 95, cadence);
      return { rounds, parts: times(rounds, () => [[30, pct, 'work', { cadence, name: 'Switchback' }], [30, pct * 0.92, 'work', { cadence: cadence - 5, hold: true, name: 'Stand up', stand: true }]]) };
    },
    // One hard, steady, seated effort.
    timeTrial: () => ({ parts: [[step(between(240, 360), 30), between(92, 97), 'work', { cadence: int(88, 94), name: 'Time trial', most: 420 }]] }),
    // A last minute to finish on: one resistance, faster every 20 seconds, flat out at the end.
    lastPush: () => ({ parts: [[20, 105, 'work', { cadence: 85, name: 'Build' }], [20, 105, 'work', { cadence: 95, hold: true, name: 'Faster' }], [20, 105, 'sprint', { cadence: 105, hold: true, name: 'Last push' }]] }),
  };
}

/**
 * Fill `budget` seconds with a class, through `add(seconds, pct, kind, opts)`.
 * `rand` is the seeded generator, so the same code gives the same class.
 */
export function buildSpinClass({ add, budget, rand, low = false, exclude = [] }) {
  const stretch = stretchFor(budget);
  const roundsScale = clamp(stretch, 1, MOST_EXTRA_ROUNDS);
  const allowed = SPIN_BLOCKS.filter((b) => b.always || (!exclude.includes(b.id) && (!low || b.gentle)));
  const titleOf = (id) => spinBlockTitle(SPIN_BLOCKS.find((b) => b.id === id), low);

  // Low impact: efforts above an easy pace are pulled 40% of the way back
  // towards it, seated, with a ceiling on cadence and on resistance.
  const ease = (pct) => (low && pct > 60 ? 60 + (pct - 60) * 0.6 : pct);
  const gentle = ([dur, pct, kind, { stand, ...opts }]) => (low
    ? [dur, ease(pct), kind, { ...opts, cadence: clamp(opts.cadence ?? LOW_CADENCES[1], ...LOW_CADENCES), resistanceCap: LOW_RESISTANCE_CAP }]
    : [dur, pct, kind, { ...opts, ...(stand ? { stand } : {}) }]);

  /** What a run of steps asks of the rider. */
  const measure = (steps) => {
    const m = { len: 0, effort: 0, stand: 0, allOut: 0, hard: 0, strain: 0, peak: 0 };
    for (const [dur, pct, kind, opts] of steps) {
      m.len += dur;
      m.effort += dur * pct;
      m.peak = Math.max(m.peak, pct);
      if (opts.stand) m.stand += dur;
      if (kind === 'sprint' || pct >= ALL_OUT_PCT) m.allOut += dur;
      if (pct >= ease(HARD_PCT)) m.hard += dur;
      m.strain += dur * Math.max(0, pct - ease(EASY_PCT));
    }
    const mean = m.effort / m.len;
    return { ...m, hardness: mean + PEAK_WEIGHT * (m.peak - mean) };
  };

  /**
   * Build a block from its own seed, so the same seed always gives the same
   * block. `load` is roughly the resistance the rider is already on (effort
   * with the cadence taken out); a block that starts from a base effort picks
   * one near it.
   */
  const make = (id, seed, load = null) => {
    const { between, int } = draws(seededRandom(seed));
    const near = (lo, hi, cadence) => {
      const drawn = between(lo, hi);
      return load === null ? drawn : clamp(load * (cadence / 80) ** CADENCE_POWER + (drawn - (lo + hi) / 2) / 2, lo, hi);
    };
    const reps = (lo, hi) => Math.round(int(lo, hi) * roundsScale);
    const made = blockMakers({ between, int, near, reps, low })[id]();
    // Long steps grow with the class, up to the most a step of that kind should last.
    const steps = made.parts.map(([dur, pct, kind, { most = Infinity, ...opts }]) => gentle([dur >= 120 ? Math.min(most, roundTo(dur * stretch, 30)) : dur, pct, kind, opts]));
    // A held step is ridden on the resistance of the step it holds, so its
    // effort follows from the change of cadence, whatever was written for it.
    let base = null;
    for (const st of steps) {
      // (Cadences are called to the nearest five, as the ride does.)
      if (st[3].hold && base) st[1] = base[1] * (roundTo(st[3].cadence, 5) / roundTo(base[3].cadence, 5)) ** CADENCE_POWER;
      else base = st;
    }
    return { id, seed, title: titleOf(id), rounds: made.rounds, steps };
  };

  /** The rest a block has earned, beyond any recovery it ends on. */
  const restAfter = (block, m) => {
    const last = block.steps.at(-1);
    const own = last[2] === 'recovery' ? last[0] : 0;
    let rest = roundTo(m.strain / REST_EARNED) - own;
    const endsHard = last[1] >= ease(HARD_PCT);
    if ((block.rounds || endsHard) && own < OWN_REST_S) rest = Math.max(rest, BETWEEN_ROUNDS_S);
    return rest < SHORTEST_REST_S ? 0 : Math.min(rest, LONGEST_REST_S);
  };
  /** An easy spell: a recovery if it's long enough to be one, otherwise flat road. */
  const spell = (dur) => (dur >= RECOVERY_FROM_S
    ? { title: 'Recovery', steps: [gentle([dur, 55, 'recovery', { cadence: 75 }])] }
    : { title: 'Flat road', steps: [gentle([dur, 68, 'steady', { cadence: 88, name: 'Flat road' }])] });

  const newSeed = () => Math.floor(rand() * 2 ** 32);
  const draft = (id) => {
    const block = make(id, newSeed());
    const m = measure(block.steps);
    return { ...block, m, rest: restAfter(block, m) };
  };
  /** A block as the last of the class: the cool-down is its recovery. */
  const asFinale = (block) => {
    const steps = [...block.steps];
    while (steps.length > 1 && steps.at(-1)[2] === 'recovery') steps.pop();
    return { ...block, steps, m: measure(steps), rest: 0, finale: true };
  };
  const shuffled = (list) => list.map((x) => [rand(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);

  /**
   * Lay blocks out on a curve that builds over the class in waves of about
   * three: the easiest block goes where the curve is lowest, the hardest where
   * it is highest.
   */
  const inWaves = (blocks) => {
    const n = blocks.length;
    const byHardness = [...blocks].sort((p, q) => p.m.hardness - q.m.hardness);
    if (n < 3) return byHardness;
    const size = Math.ceil(n / Math.max(1, Math.round(n / 3)));
    const height = (i) => i / (n - 1) + (i % size) / (size - 1);
    const slots = blocks.map((_, i) => i).sort((p, q) => height(p) - height(q) || p - q);
    const order = [];
    slots.forEach((slot, rank) => { order[slot] = byHardness[rank]; });
    return order;
  };

  /** One possible class: an opener, blocks with their rests, and a finale. */
  const draftClass = () => {
    const pool = () => shuffled(allowed.filter((b) => !b.always).map((b) => ({ ...draft(b.id), finaleOnly: b.finaleOnly })));
    const opener = { ...draft('flat'), rest: 0 };
    let candidates = pool();

    // The finale is one of the hardest blocks that fit, and is set aside first.
    // In a very short class it may be all there is room for, or not fit at all.
    const after = budget - opener.m.len - LEAD_IN_S;
    const fitting = candidates.map(asFinale).filter((b) => b.m.len <= after);
    const roomy = fitting.filter((b) => b.m.len <= after - SHORTEST_BODY_S);
    const closers = (roomy.length ? roomy : fitting).sort((p, q) => q.m.hardness - p.m.hardness);
    const finale = closers.length ? closers[Math.floor(rand() * Math.ceil(closers.length * FINALE_SHARE))] : null;

    // Then as many blocks as fit, each with the rest it earns. No block comes
    // round again until every other has been used, so a short block that fits
    // anywhere doesn't crowd out the long ones.
    let room = budget - opener.m.len - (finale ? finale.m.len + LEAD_IN_S : 0);
    let standLeft = Math.max(0, budget * STAND_SHARE - (finale?.m.stand ?? 0));
    let allOutLeft = Math.max(0, Math.max(60, budget * ALL_OUT_SHARE) - (finale?.m.allOut ?? 0));
    const body = [];
    let used = new Set(finale ? [finale.id] : []);
    const usable = allowed.filter((b) => !b.always && !b.finaleOnly).length;
    for (let sweep = 0, empty = 0; sweep < 12 && empty < 3; sweep++) {
      let added = 0;
      for (const b of candidates) {
        if (used.size >= usable) used = new Set();
        if (b.finaleOnly || used.has(b.id) || (finale && b.m.hardness > finale.m.hardness)) continue;
        if (b.m.len + b.rest > room || b.m.stand > standLeft || b.m.allOut > allOutLeft) continue;
        body.push(b);
        used.add(b.id);
        room -= b.m.len + b.rest;
        standLeft -= b.m.stand;
        allOutLeft -= b.m.allOut;
        added += 1;
      }
      empty = added ? 0 : empty + 1;
      candidates = pool();
    }

    // In that order, each block is built again to start near the resistance
    // the one before it ended on. That can shift its efforts a little, so it
    // is measured again and its rest worked out afresh. If the class no longer
    // fits, a block is dropped and the rest are laid out again.
    const ownRest = (b) => (b.steps.at(-1)[2] === 'recovery' ? b.steps.at(-1)[0] : 0);
    let blocks, rests, filled;
    for (;;) {
      let load = null;
      blocks = [opener, ...inWaves(body), ...(finale ? [finale] : [])].map((b) => {
        const joined = make(b.id, b.seed, load);
        for (const [, pct, kind, opts] of joined.steps) {
          if (kind !== 'recovery' && !opts.hold && opts.cadence) load = pct / (opts.cadence / 80) ** CADENCE_POWER;
        }
        if (b.finale) return { ...asFinale(joined), fixed: true };
        const m = measure(joined.steps);
        return { ...joined, m, rest: b === opener ? 0 : restAfter(joined, m), fixed: !!joined.rounds };
      });
      // The easy riding before the finale, a block's own recovery included,
      // is at least a short lead-in.
      // (A few seconds more aren't worth a spell of their own.)
      const leadIn = (b) => {
        const more = LEAD_IN_S - ownRest(b);
        return more >= SHORTEST_REST_S || ownRest(b) < OWN_REST_S ? Math.max(more, SHORTEST_REST_S) : 0;
      };
      rests = blocks.map((b, k) => (finale && k === blocks.length - 2 ? Math.max(b.rest, leadIn(b)) : b.rest));
      filled = blocks.reduce((a, b) => a + b.m.len, 0) + rests.reduce((a, r) => a + r, 0);
      if (filled <= budget || !body.length) break;
      body.pop();
    }
    const whole = measure(blocks.flatMap((b, i) => [...b.steps, ...(rests[i] ? spell(rests[i]).steps : [])]));
    const upstaged = finale && blocks.slice(0, -1).some((b) => b.m.hardness > blocks.at(-1).m.hardness);
    // How far from the target, in rough units of "a noticeable difference".
    const miss = Math.abs(whole.effort / whole.len - ease(TARGET_MEAN_PCT)) / MEAN_MISS
      + Math.abs(whole.hard / whole.len - TARGET_HARD_SHARE) / HARD_MISS
      + (budget - filled) / LEFT_MISS_S
      + (upstaged ? UPSTAGED_MISS : 0);
    return { blocks, rests, left: budget - filled, miss };
  };

  let best = null;
  for (let i = 0; i < DRAFTS; i++) {
    const made = draftClass();
    if (!best || made.miss < best.miss) best = made;
  }

  // The chosen class, with its rests in place.
  const items = [];
  best.blocks.forEach((b, i) => {
    items.push(b);
    if (best.rests[i]) items.push({ ...spell(best.rests[i]), leadIn: i === best.blocks.length - 2 && !!best.blocks.at(-1).finale });
  });

  // Left-over time lengthens the steady steps a little, a quarter of a minute
  // at a time, longest first. Anything still over goes before the finale.
  let left = best.left;
  const steady = items.filter((it) => !it.fixed).flatMap((it) => it.steps)
    .filter((s) => s[0] >= 60 && !s[3].stand && s[1] < ease(HARD_PCT))
    .map((s) => ({ s, room: Math.floor((s[0] * MOST_STRETCH) / 15) * 15 }))
    .sort((p, q) => q.s[0] - p.s[0]);
  while (left >= 15 && steady.some((x) => x.room >= 15)) {
    for (const x of steady) {
      if (left < 15 || x.room < 15) continue;
      x.s[0] += 15;
      x.room -= 15;
      left -= 15;
    }
  }
  // (In the shortest class the opener alone may be too long, and is cut to fit.)
  if (left !== 0) (items.find((it) => it.leadIn) ?? items[0]).steps[0][0] += left;

  for (const { title, rounds, steps } of items) {
    steps.forEach(([dur, pct, kind, opts], i) => {
      add(dur, pct, kind, { ...opts, block: title, ...(i === 0 ? { blockStart: true, ...(rounds ? { rounds } : {}) } : {}) });
    });
  }
}
