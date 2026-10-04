import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkout } from '../src/core/workout.js';
import { DEFAULT_MODEL, powerFor } from '../src/core/resistance.js';
import { Ghost, pacerGhost, targetWatts } from '../src/core/ghost.js';
import { RideSession, isOnTarget, formatRange } from '../src/core/ride.js';
import { speedFromPower } from '../src/core/physics.js';
import { Storage } from '../src/core/storage.js';

test('speed from power is monotonic and realistic', () => {
  assert.equal(speedFromPower(0), 0);
  const v200 = speedFromPower(200) * 3.6;
  assert.ok(v200 > 30 && v200 < 40, `200 W -> ${v200} km/h`);
  assert.ok(speedFromPower(300) > speedFromPower(200));
});

test('ghost interpolates between seconds and holds at the end', () => {
  const g = new Ghost('pb', 'PB', [0, 10, 30]);
  assert.equal(g.distanceAt(0.5), 5);
  assert.equal(g.distanceAt(1.5), 20);
  assert.equal(g.distanceAt(99), 30);
  assert.equal(g.finalDistance, 30);
});

function rideAt(workout, ghost, powerFn, dt = 0.25) {
  const s = new RideSession({ workout, baselineW: 200, model: DEFAULT_MODEL, ghost });
  const events = [];
  while (!s.done) {
    const seg = s.snapshot().seg;
    s.setInput({ powerW: powerFn(seg, s.t), cadence: 88 });
    for (const e of s.update(dt)) events.push({ e, t: s.t });
  }
  return { s, events };
}

test('riding exactly on target ties the pacer and records every second', () => {
  const w = generateWorkout('intervals', 22, 0);
  const pacer = pacerGhost(w, 200);
  const { s } = rideAt(w, pacer, (seg) => targetWatts(seg, 200));
  assert.ok(Math.abs(s.dist - pacer.finalDistance) < 1, `gap ${s.dist - pacer.finalDistance}`);
  assert.equal(s.samples.d.length, w.totalS + 1);
  assert.equal(s.samples.p.length, w.totalS);
  const sum = s.summary();
  assert.ok(sum.onTargetPct > 95, `on target ${sum.onTargetPct}`);
  assert.equal(sum.gates.length, w.gates.length);
});

test('riding harder beats the pacer, wins gates and fires one pass event', () => {
  const w = generateWorkout('intervals', 22, 0);
  const pacer = pacerGhost(w, 200);
  const { s, events } = rideAt(w, pacer, (seg, t) => (t < 60 ? 50 : targetWatts(seg, 200) * 1.1));
  const sum = s.summary();
  assert.ok(sum.gap > 50, `gap ${sum.gap}`);
  assert.ok(sum.gates.every((g) => g.won));
  assert.equal(events.filter((x) => x.e === 'passedGhost').length, 1);
  assert.equal(events.filter((x) => x.e === 'done').length, 1);
  assert.equal(events.filter((x) => x.e === 'gateStart').length, w.gates.length);
});

test('no data for a few seconds counts as stopped pedalling', () => {
  const w = generateWorkout('endurance', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  s.setInput({ powerW: 200, cadence: 90 });
  for (let i = 0; i < 40; i++) s.update(0.25);
  assert.equal(s.snapshot().noSignal, true);
  assert.equal(s.snapshot().powerW, 0);
  s.setInput({ powerW: 180 });
  assert.equal(s.snapshot().noSignal, false);
  assert.equal(s.snapshot().cadence, 90);
});

function rideToFirstClimb(knob, cadence) {
  const w = generateWorkout('intervals', 30, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const climb = w.segments.find((x) => x.kind === 'work');
  while (s.t < climb.start + 20) {
    s.setInput({ powerW: powerFor(DEFAULT_MODEL, knob, cadence), cadence });
    s.update(0.5);
  }
  return { s, climb };
}

test('every step has a cadence target and a knob target from the model', () => {
  const { s, climb } = rideToFirstClimb(38, 80);
  const snap = s.snapshot();
  assert.equal(snap.seg, climb);
  assert.equal(snap.targetCadence, 80);
  assert.equal(snap.targetW, 210);
  // The knob target gives the step's watts at the step's cadence.
  assert.ok(Math.abs(powerFor(DEFAULT_MODEL, snap.targetKnob, 80) - snap.targetW) < 6);
  assert.ok(snap.targetKnob > 38);
});

test('knob is corrected first, then cadence', () => {
  let snap = rideToFirstClimb(38, 80).s.snapshot();
  assert.equal(snap.resistance, 38);
  assert.equal(snap.knobStatus, 'low');
  assert.equal(snap.cadenceStatus, 'on');
  assert.deepEqual(snap.knobRange, [snap.targetKnob - 2, snap.targetKnob + 2]);
  assert.deepEqual(snap.cadenceRange, [75, 85]);
  assert.deepEqual(snap.cue, { type: 'up', text: `Resistance up to ${snap.targetKnob - 2}–${snap.targetKnob + 2}` });

  const tk = snap.targetKnob;
  snap = rideToFirstClimb(tk, 95).s.snapshot();
  assert.equal(snap.knobStatus, 'on');
  assert.equal(snap.cadenceStatus, 'high');
  assert.deepEqual(snap.cue, { type: 'down', text: 'Ease the cadence · 75–85 rpm' });

  snap = rideToFirstClimb(tk, 81).s.snapshot();
  assert.equal(snap.cue.type, 'ok');
  assert.equal(snap.onTarget, true);
});

test('matching cadence and knob counts as on target even if the watts disagree', () => {
  // The bike reports its knob directly and its watts read 15% high (an
  // uncalibrated model): following the plan still counts.
  const w = generateWorkout('intervals', 30, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const climb = w.segments.find((x) => x.kind === 'work');
  const tg = s.targetsFor(climb);
  while (s.t < climb.start + 30) {
    const inClimb = s.t >= climb.start;
    const knob = inClimb ? tg.knob : 20;
    s.setInput({ powerW: powerFor(DEFAULT_MODEL, knob, tg.cadence) * 1.15, cadence: tg.cadence, resistance: knob });
    s.update(0.5);
  }
  const snap = s.snapshot();
  assert.equal(snap.knobStatus, 'on');
  assert.equal(snap.cadenceStatus, 'on');
  assert.equal(isOnTarget(climb, 200, snap.powerW, snap.cadence), false);
  assert.equal(snap.onTarget, true);
});

test('sprints have open-ended ranges', () => {
  const w = generateWorkout('sprints', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const tg = s.targetsFor(w.segments.find((x) => x.kind === 'sprint'));
  assert.deepEqual(tg.cadenceRange, [100, null]);
  assert.equal(tg.knobRange[1], null);
  assert.deepEqual(tg.wattsRange, [240, null]);
  assert.equal(formatRange(tg.cadenceRange), '100+');
});

test('summary reports average cadence and knob for each hard effort', () => {
  const w = generateWorkout('intervals', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  while (!s.done) {
    const seg = s.snapshot().seg;
    const tg = s.targetsFor(seg);
    s.setInput({ powerW: powerFor(DEFAULT_MODEL, tg.knob, tg.cadence), cadence: tg.cadence });
    s.update(0.5);
  }
  const c = s.summary().climbs[0];
  assert.equal(c.avgCadence, c.targetCadence);
  assert.ok(Math.abs(c.avgKnob - c.targetKnob) <= 1);
  assert.ok(c.onTargetPct > 90);
});

test('a bike that reports resistance is believed over the model', () => {
  const w = generateWorkout('endurance', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  s.setInput({ powerW: 120, cadence: 85, resistance: 55 });
  s.update(0.5);
  assert.equal(s.snapshot().resistance, 55);
});

test('on-target rules for sprints and drills', () => {
  assert.equal(isOnTarget({ kind: 'sprint', pct: 150 }, 200, 260, 110), true);
  assert.equal(isOnTarget({ kind: 'sprint', pct: 150 }, 200, 200, 110), false);
  assert.equal(isOnTarget({ kind: 'drill', pct: 60, cadence: 110 }, 200, 50, 107), true);
  assert.equal(isOnTarget({ kind: 'drill', pct: 60, cadence: 110 }, 200, 120, 90), false);
});

test('storage keeps PB and last ride per workout code', () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const st = new Storage(store);
  st.saveRide({ id: 'a', code: 'INT-30-K7Q', date: '2026-09-08', distanceM: 13600, samples: { d: [0] } });
  st.saveRide({ id: 'b', code: 'INT-30-K7Q', date: '2026-09-15', distanceM: 14200, samples: { d: [0] } });
  st.saveRide({ id: 'c', code: 'INT-30-K7Q', date: '2026-09-22', distanceM: 13900, samples: { d: [0] } });
  st.saveRide({ id: 'd', code: 'END-22-K7Q', date: '2026-09-23', distanceM: 9000, samples: { d: [0] } });
  assert.equal(st.bestRide('INT-30-K7Q').id, 'b');
  assert.equal(st.lastRide('INT-30-K7Q').id, 'c');
  assert.equal(st.ridesFor('INT-30-K7Q').length, 3);
  const json = st.exportAll();
  const st2 = new Storage({ getItem: () => null, setItem: () => {} });
  assert.equal(st2.importAll(json), 4);
  assert.throws(() => st2.importAll('{"app":"other"}'));
});

test('storage survives a broken or missing localStorage', () => {
  const st = new Storage({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
  assert.equal(st.loadSettings().baselineW, 200);
  assert.deepEqual(st.allRides(), []);
  assert.equal(new Storage(undefined).loadSettings().baselineW, 200);
});
