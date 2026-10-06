import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFor, resistanceAtLevel, feelLevel, feelWord, onKnob, FULL_KNOB } from '../src/core/knob.js';
import { DEFAULT_MODEL } from '../src/core/resistance.js';
import { stepTargets, easyPaceResistance, RideSession } from '../src/core/ride.js';
import { generateWorkout } from '../src/core/workout.js';
import { spokenCue } from '../src/core/cues.js';
import { Storage } from '../src/core/storage.js';

test('a knob marked 1 to 100 is Pacer\'s own scale', () => {
  for (const r of [1, 37, 100]) {
    assert.equal(levelFor(r, FULL_KNOB), r);
    assert.equal(resistanceAtLevel(r, FULL_KNOB), r);
  }
  const tg = stepTargets({ kind: 'work', pct: 90, cadence: 70 }, [], 200, DEFAULT_MODEL);
  assert.equal(onKnob(tg, FULL_KNOB, 50), tg);
});

test('a knob with fewer levels covers the same travel in fewer steps', () => {
  assert.equal(levelFor(1, 8), 1);
  assert.equal(levelFor(100, 8), 8);
  assert.equal(levelFor(50, 8), 4);
  assert.equal(levelFor(-5, 8), 1);
  assert.equal(levelFor(140, 8), 8);
  for (let level = 1; level <= 16; level++) assert.equal(levelFor(resistanceAtLevel(level, 16), 16), level);
});

test('a band that lands on one level is shown as that level', () => {
  const tg = { exactResistance: 44, resistance: 44, resistanceRange: [40, 50], resistanceIsExact: false };
  const on8 = onKnob(tg, 8, 50);
  assert.deepEqual(on8.resistanceRange, [4, 4]);
  assert.equal(on8.resistance, 4);
  assert.ok(on8.resistanceIsExact);
  const on32 = onKnob(tg, 32, 50);
  assert.deepEqual(on32.resistanceRange, [13, 16]);
  assert.ok(!on32.resistanceIsExact);
  // A sprint's band has no top, on any knob.
  assert.deepEqual(onKnob({ ...tg, resistanceRange: [40, null] }, 8, 50).resistanceRange, [4, null]);
});

test('a knob with no numbers is told how heavy it should feel, from the easy pace', () => {
  assert.equal(feelWord(feelLevel(50, 50)), 'Moderate');
  assert.equal(feelWord(feelLevel(42, 50)), 'Light');
  assert.equal(feelWord(feelLevel(58, 50)), 'Firm');
  assert.equal(feelWord(feelLevel(65, 50)), 'Heavy');
  assert.equal(feelWord(feelLevel(80, 50)), 'Very heavy');
  const easy = easyPaceResistance(DEFAULT_MODEL, 200, 80);
  const at = (seg) => onKnob(stepTargets(seg, [seg], 200, DEFAULT_MODEL), 0, easy).feel;
  assert.equal(at({ kind: 'steady', pct: 70, cadence: 80 }), 'Moderate');
  assert.equal(at({ kind: 'recovery', pct: 50, cadence: 85 }), 'Light');
  assert.equal(at({ kind: 'work', pct: 105, cadence: 65 }), 'Very heavy');
});

test('a ride without a smart bike runs on its own, calls every change and scores nothing', () => {
  const workout = generateWorkout('intervals', 22, 0);
  const plain = new RideSession({ workout, baselineW: 200, model: DEFAULT_MODEL, ghost: null, follow: true });
  const changes = [];
  while (!plain.done) for (const e of plain.update(0.5)) changes.push(e);
  assert.equal(plain.t, workout.totalS);
  assert.ok(changes.filter((e) => e === 'stepChange').length > 5);
  assert.equal(changes.filter((e) => e === 'done').length, 1);
  assert.ok(!changes.some((e) => ['gateStart', 'passedGhost', 'ghostPassed'].includes(e)));
  assert.equal(plain.onTargetS, 0);
  assert.deepEqual(plain.summary(), { follow: true, durationS: workout.totalS, avgEffort: 1 });

  // The road still moves, at the pace the targets stand for.
  assert.ok(plain.dist > 1000);
  const snap = plain.snapshot();
  assert.equal(snap.follow, true);
  assert.equal(snap.noSignal, false);
  assert.equal(snap.cadenceStatus, null);
  assert.equal(snap.gap, 0);
});

test('without a smart bike, targets and cues are in the knob\'s units', () => {
  const workout = generateWorkout('hills', 30, 0);
  const on8 = new RideSession({ workout, baselineW: 200, model: DEFAULT_MODEL, ghost: null, follow: true, knob: 8 });
  const hill = workout.segments.find((s) => s.kind === 'work');
  const tg = on8.targetsFor(hill);
  assert.ok(tg.resistance >= 1 && tg.resistance <= 8);
  assert.ok(tg.exactResistance > 8, 'hills are still drawn on the 1-100 scale');
  const [lo, hi] = tg.resistanceRange;
  assert.match(spokenCue(hill, tg), new RegExp(`Resistance ${lo === hi ? lo : `${lo} to ${hi}`}, cadence ${tg.cadence}\\.`));

  const unmarked = new RideSession({ workout, baselineW: 200, model: DEFAULT_MODEL, ghost: null, follow: true, knob: 0 });
  const felt = unmarked.targetsFor(hill);
  assert.ok(['Firm', 'Heavy', 'Very heavy'].includes(felt.feel), felt.feel);
  assert.match(spokenCue(hill, felt), new RegExp(`${felt.feel}, cadence ${felt.cadence}\\.`));
});

test('rides without a smart bike are kept, but never raced as ghosts', () => {
  const mem = new Map();
  const store = new Storage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) });
  store.saveRide({ id: 'a', code: 'INT-30-K7Q', date: '2026-01-01', distanceM: 9000, durationS: 1800, samples: { d: [0] } });
  store.saveRide({ id: 'b', code: 'INT-30-K7Q', date: '2026-01-02', follow: true, durationS: 1800 });
  assert.equal(store.ridesFor('INT-30-K7Q').length, 2);
  assert.equal(store.bestRide('INT-30-K7Q').id, 'a');
  assert.equal(store.lastRide('INT-30-K7Q').id, 'a');
});
