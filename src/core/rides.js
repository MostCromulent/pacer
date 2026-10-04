// The main set of every kind of ride except the spin classes (see spinclass.js).
//
// To add a ride: write a builder here, and list it in TYPES in workout.js under
// the same id. A builder is given a budget in seconds and spends it by calling
// add(seconds, pct, kind, options); the warm-up and cool-down are added around it.

import { buildSpinClass } from './spinclass.js';
import { clamp, draws, roundTo, stretchFor } from './util.js';

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
export function makeBuilders(add, v, rand, exclude = []) {
  const cruise = (sec) => add(sec, 62, 'steady', { name: 'Cruise' });
  const { between } = draws(rand);
  const step = roundTo;
  const stretch = stretchFor;

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
  const clampInt = (x, lo, hi) => clamp(Math.round(x), lo, hi);

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
      const ps = [[52, 55], [50, 54], [53, 55]][v];
      let left = budget;
      let i = 0;
      while (left >= blk) { add(blk, ps[i % 2], 'steady', { cadence: 75, name: 'Easy spin' }); left -= blk; i++; }
      add(left, ps[0], 'steady', { cadence: 75, name: 'Easy spin' });
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

    sweetspot(budget) {
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
      cruise(budget - inSets(budget, on + off, () => { add(on, 150, 'sprint'); add(off, 55, 'recovery'); }));
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

    // Spin classes are built from blocks: see spinclass.js.
    spinclass(budget) {
      buildSpinClass({ add, budget, rand, exclude });
    },

    spinlow(budget) {
      buildSpinClass({ add, budget, rand, exclude, low: true });
    },
  };
  return b;
}
