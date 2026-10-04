import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkout } from '../src/core/workout.js';
import { DEFAULT_MODEL, powerFor } from '../src/core/resistance.js';
import { Ghost, pacerGhost, targetWatts } from '../src/core/ghost.js';
import { RideSession, isOnTarget } from '../src/core/ride.js';
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

test('knob hint uses the model and the rider cadence', () => {
  const w = generateWorkout('intervals', 30, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const climb = w.segments.find((x) => x.kind === 'work');
  // Ride to the first climb at a low effort.
  while (s.t < climb.start + 20) {
    s.setInput({ powerW: powerFor(DEFAULT_MODEL, 38, 88), cadence: 88 });
    s.update(0.5);
  }
  const snap = s.snapshot();
  assert.equal(snap.seg, climb);
  assert.equal(snap.resistance, 38);
  assert.equal(snap.cue.type, 'up');
  assert.match(snap.cue.text, /^Knob 38 → \d+$/);
  const want = Number(snap.cue.text.split('→ ')[1]);
  assert.ok(Math.abs(powerFor(DEFAULT_MODEL, want, 88) - snap.targetW) < 6);
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
