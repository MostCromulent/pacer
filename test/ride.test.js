import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkout } from '../src/core/workout.js';
import { DEFAULT_MODEL, powerFor } from '../src/core/resistance.js';
import { Ghost, pacerGhost, targetWatts } from '../src/core/ghost.js';
import { RideSession, isOnTarget, stepTargets, resistanceBlock } from '../src/core/ride.js';
import { formatRange, spokenCue, stepAction } from '../src/core/cues.js';
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

function rideToFirstClimb(resistance, cadence) {
  const w = generateWorkout('intervals', 30, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const climb = w.segments.find((x) => x.kind === 'work');
  while (s.t < climb.start + 20) {
    s.setInput({ powerW: powerFor(DEFAULT_MODEL, resistance, cadence), cadence });
    s.update(0.5);
  }
  return { s, climb };
}

test('every step has a cadence target and a resistance target from the model', () => {
  const { s, climb } = rideToFirstClimb(38, 80);
  const snap = s.snapshot();
  assert.equal(snap.seg, climb);
  assert.equal(snap.targetCadence, 80);
  assert.equal(snap.targetW, 210);
  // The resistance target gives the step's watts at the step's cadence.
  assert.ok(Math.abs(powerFor(DEFAULT_MODEL, snap.targetResistance, 80) - snap.targetW) < 6);
  assert.ok(snap.targetResistance > 38);
});

test('resistance and cadence are each judged against their own range', () => {
  let snap = rideToFirstClimb(38, 80).s.snapshot();
  assert.equal(snap.resistance, 38);
  assert.equal(snap.resistanceStatus, 'low');
  assert.equal(snap.cadenceStatus, 'on');
  // The target is shown as the block of five levels it falls in.
  const [lo, hi] = snap.resistanceRange;
  assert.ok(lo % 5 === 0 && hi - lo === 5 && lo <= snap.targetResistance && snap.targetResistance <= hi);
  assert.deepEqual(snap.cadenceRange, [75, 85]);

  const tk = snap.targetResistance;
  snap = rideToFirstClimb(tk, 95).s.snapshot();
  assert.equal(snap.resistanceStatus, 'on');
  assert.equal(snap.cadenceStatus, 'high');

  snap = rideToFirstClimb(tk, 81).s.snapshot();
  assert.equal(snap.resistanceStatus, 'on');
  assert.equal(snap.cadenceStatus, 'on');
  assert.equal(snap.onTarget, true);
});

test('matching cadence and resistance counts as on target even if the watts disagree', () => {
  // The bike reports its resistance directly and its watts read 15% high (an
  // uncalibrated model): following the plan still counts.
  const w = generateWorkout('intervals', 30, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const climb = w.segments.find((x) => x.kind === 'work');
  const tg = s.targetsFor(climb);
  while (s.t < climb.start + 30) {
    const inClimb = s.t >= climb.start;
    const resistance = inClimb ? tg.resistance : 20;
    s.setInput({ powerW: powerFor(DEFAULT_MODEL, resistance, tg.cadence) * 1.15, cadence: tg.cadence, resistance: resistance });
    s.update(0.5);
  }
  const snap = s.snapshot();
  assert.equal(snap.resistanceStatus, 'on');
  assert.equal(snap.cadenceStatus, 'on');
  assert.equal(isOnTarget(climb, 200, snap.powerW, snap.cadence), false);
  assert.equal(snap.onTarget, true);
});

test('sprints have open-ended ranges', () => {
  const w = generateWorkout('sprints', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const tg = s.targetsFor(w.segments.find((x) => x.kind === 'sprint'));
  assert.deepEqual(tg.cadenceRange, [100, null]);
  assert.equal(tg.resistanceRange[1], null);
  assert.deepEqual(tg.wattsRange, [240, null]);
  assert.equal(formatRange(tg.cadenceRange), '100+');
});

test('effort control scales power and resistance targets, not cadence', () => {
  const w = generateWorkout('intervals', 30, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const climb = w.segments.find((x) => x.kind === 'work');
  const base = s.targetsFor(climb);
  assert.equal(s.nudgeEffort(+1), 1.1);
  const harder = s.targetsFor(climb);
  assert.equal(harder.watts, Math.round(base.watts * 1.1));
  assert.equal(harder.cadence, base.cadence);
  assert.ok(harder.resistance > base.resistance);
  assert.equal(s.snapshot().effort, 1.1);
  // Clamped and snapped to 10% steps.
  assert.equal(s.setEffort(2), 1.5);
  assert.equal(s.setEffort(0.1), 0.5);
  assert.equal(s.setEffort(1.04), 1);
  for (let i = 0; i < 20; i++) s.nudgeEffort(-1);
  assert.equal(s.effort, 0.5);
});

test('summary reports the average effort over the ride', () => {
  const w = generateWorkout('endurance', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  while (!s.done) {
    if (Math.abs(s.t - w.totalS / 2) < 0.3) s.setEffort(1.2);
    s.setInput({ powerW: 150, cadence: 88 });
    s.update(0.5);
  }
  assert.equal(s.summary().avgEffort, 1.1);
});

test('summary reports average cadence and resistance for each hard effort', () => {
  const w = generateWorkout('intervals', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  while (!s.done) {
    const seg = s.snapshot().seg;
    const tg = s.targetsFor(seg);
    s.setInput({ powerW: powerFor(DEFAULT_MODEL, tg.resistance, tg.cadence), cadence: tg.cadence });
    s.update(0.5);
  }
  const c = s.summary().climbs[0];
  assert.equal(c.avgCadence, c.targetCadence);
  assert.ok(Math.abs(c.avgResistance - c.targetResistance) <= 1);
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

test('no step-change heads-up inside short HIIT reps', () => {
  const w = generateWorkout('hiit', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const firstRep = w.segments.find((x) => x.kind === 'work');
  const events = [];
  while (s.t < firstRep.start + 120) {
    s.setInput({ powerW: 200, cadence: 95 });
    for (const e of s.update(0.25)) if (s.t > firstRep.start) events.push(e);
  }
  assert.equal(events.filter((e) => e === 'stepSoon').length, 0);
  assert.ok(events.filter((e) => e === 'stepChange').length >= 7);
});

test('HIIT rests hold the rep resistance and only drop the cadence', () => {
  const w = generateWorkout('hiit', 22, 0);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const repIdx = w.segments.findIndex((x) => x.kind === 'work');
  const rep = s.targetsFor(w.segments[repIdx]);
  const rest = s.targetsFor(w.segments[repIdx + 1]);
  assert.equal(w.segments[repIdx + 1].hold, true);
  assert.equal(rest.resistance, rep.resistance);
  assert.ok(rest.cadence < rep.cadence);
  assert.ok(rest.watts < rep.watts);
  // The long rest between blocks is a normal step again.
  const longRest = w.segments.find((x) => x.label === 'Rest' && x.dur === 180);
  assert.ok(!longRest.hold);
  assert.ok(s.targetsFor(longRest).resistance < rep.resistance);
});

test('a pacer built from the shown targets ties a rider who follows them in HIIT', () => {
  const w = generateWorkout('hiit', 22, 0);
  const wattsFor = (seg) => stepTargets(seg, w.segments, 200, DEFAULT_MODEL).watts;
  const pacer = pacerGhost(w, 200, wattsFor);
  const s = new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacer });
  while (!s.done) {
    const tg = s.targetsFor(s.snapshot().seg);
    s.setInput({ powerW: tg.watts, cadence: tg.cadence });
    s.update(0.25);
  }
  assert.ok(Math.abs(s.summary().gap) < 2, `gap ${s.summary().gap}`);
  // And the zone shown for a held rest reflects its real effort.
  const rest = w.segments.find((x) => x.hold);
  assert.ok(stepTargets(rest, w.segments, 200, DEFAULT_MODEL).watts / 200 > 0.6);
});

test('a ride can be deleted from storage', async () => {
  const { Storage } = await import('../src/core/storage.js');
  const items = new Map();
  const store = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
  const st = new Storage(store);
  st.saveRide({ id: 'a', code: 'X', date: '2026-01-01', distanceM: 1 });
  st.saveRide({ id: 'b', code: 'X', date: '2026-01-02', distanceM: 2 });
  st.deleteRide('a');
  assert.deepEqual(st.allRides().map((r) => r.id), ['b']);
});

test('spoken cues name the step and its two targets', async () => {
  const tg = { resistance: 45, cadence: 70, watts: 260 };
  assert.equal(spokenCue({ kind: 'work', dur: 120, label: 'Hill 2 of 7' }, tg), 'Hill. Resistance 45, cadence 70.');
  assert.equal(spokenCue({ kind: 'work', dur: 150, label: 'Mountain 1 · climb 2/4' }, tg), 'Climb. Resistance 45, cadence 70.');
  assert.equal(spokenCue({ kind: 'work', dur: 120, label: 'Hill' }, tg, 'watts'), 'Hill. 260 watts, cadence 70.');
  assert.equal(spokenCue({ kind: 'sprint', dur: 30, label: 'Sprint 1 of 4' }, tg), 'Sprint. All out.');
  // In a run of short reps only the first gets the numbers.
  const rest = { kind: 'recovery', dur: 10, hold: true, label: 'Rest' };
  assert.equal(spokenCue({ kind: 'work', dur: 20, label: 'Tabata 1 · rep 1/8' }, tg), 'Resistance 45, cadence 70. Go.');
  assert.equal(spokenCue({ kind: 'work', dur: 20, label: 'Tabata 1 · rep 3/8' }, tg, 'resistance', rest), 'Go.');
  assert.equal(spokenCue(rest, tg, 'resistance', { dur: 20 }), 'Rest.');
  assert.equal(spokenCue({ kind: 'steady', dur: 30, hold: true, label: 'Settle' }, tg), 'Settle. Same resistance, cadence 70.');
});

test('spoken cues call getting out of the saddle and back into it', async () => {
  const tg = { resistance: 55, cadence: 65, watts: 300 };
  const flat = { kind: 'steady', dur: 240, label: 'Flat road', position: 'seated' };
  const climb = { kind: 'work', dur: 180, label: 'Standing climb', position: 'standing' };
  assert.equal(spokenCue(climb, tg, 'resistance', flat), 'Standing climb. Out of the saddle. Resistance 55, cadence 65.');
  assert.equal(spokenCue(climb, tg, 'resistance', climb), 'Standing climb. Resistance 55, cadence 65.');
  assert.equal(spokenCue(flat, tg, 'resistance', climb), 'Flat road. Back in the saddle. Resistance 55, cadence 65.');
  assert.equal(spokenCue({ kind: 'work', dur: 20, label: 'Jump 2 of 4', position: 'standing' }, tg, 'resistance', flat, true), 'Up.');
});

test('a creeping climb just calls the new resistance', async () => {
  const seg = { kind: 'work', dur: 20, creep: true, label: 'Creep 3/9', position: 'seated' };
  assert.equal(spokenCue(seg, { resistance: 41, cadence: 80, watts: 250 }), 'Resistance 41.');
  assert.equal(spokenCue(seg, { resistance: 41, cadence: 80, watts: 250 }, 'watts'), '250 watts.');
});

test('each step has a one-word instruction', async () => {
  assert.deepEqual(stepAction({ kind: 'work' }), { text: 'Push', tone: 'push' });
  assert.deepEqual(stepAction({ kind: 'recovery' }), { text: 'Recover', tone: 'recover' });
  assert.deepEqual(stepAction({ kind: 'work', creep: true }, 2), { text: 'Add 2', tone: 'add' });
  assert.deepEqual(stepAction({ kind: 'work', creep: true }, -20), { text: 'Build', tone: 'add' });
  assert.deepEqual(stepAction({ kind: 'sprint' }), { text: 'All out', tone: 'push' });
  // Ordinary riding gets no badge.
  for (const kind of ['steady', 'warmup', 'cooldown', 'drill']) assert.equal(stepAction({ kind }), null);
});

test('a ride can be saved part-way and carried on with', () => {
  const w = generateWorkout('intervals', 30, 0);
  const make = () => new RideSession({ workout: w, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(w, 200) });
  const first = make();
  for (let i = 0; i < 600; i++) {
    first.setInput({ powerW: 180, cadence: 85 });
    first.update(1);
  }
  // Through JSON, as it would be in the browser's storage.
  const second = make().restore(JSON.parse(JSON.stringify(first.save())));
  assert.equal(second.t, 600);
  assert.equal(second.dist, first.dist);
  assert.equal(second.samples.d.length, first.samples.d.length);
  for (const s of [first, second]) {
    for (let i = 0; i < 60; i++) {
      s.setInput({ powerW: 180, cadence: 85 });
      s.update(1);
    }
  }
  assert.equal(second.t, 660);
  assert.ok(Math.abs(second.dist - first.dist) < 1e-6);
  assert.deepEqual(second.summary().climbs, first.summary().climbs);
});

test('an unfinished ride is kept for a while, then forgotten', async () => {
  const { Storage } = await import('../src/core/storage.js');
  const items = new Map();
  const st = new Storage({ getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: (k) => items.delete(k) });
  assert.equal(st.loadResume(), null);
  st.saveResume({ type: 'intervals', minutes: 30, variant: 0, session: { t: 300 } });
  assert.equal(st.loadResume().session.t, 300);
  assert.equal(st.loadResume(Date.now() + 7 * 60 * 60 * 1000), null);
  st.clearResume();
  assert.equal(st.loadResume(), null);
});

test('the backup carries the calibration with the rides and settings', async () => {
  const { Storage } = await import('../src/core/storage.js');
  const store = () => { const items = new Map(); return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: (k) => items.delete(k) }; };
  const a = new Storage(store());
  a.saveRide({ id: 'r1', code: 'INT-30-K7Q', date: '2026-01-01', distanceM: 9000 });
  a.saveSettings({ ...a.loadSettings(), baselineW: 319 });
  a.saveCalibration({ bike: 'IC Bike', model: { kind: 'table', b: 1.6, knots: [[20, -1.8], [80, -0.6]], calibrated: true }, bins: { 20: { 85: [10, 44.4, 52.3] } } });
  const b = new Storage(store());
  assert.equal(b.loadCalibration(), null);
  b.importAll(a.exportAll());
  assert.equal(b.allRides().length, 1);
  assert.equal(b.loadSettings().baselineW, 319);
  assert.equal(b.loadCalibration().bike, 'IC Bike');
  assert.deepEqual(b.loadCalibration().bins, a.loadCalibration().bins);
});

test('targets come in round numbers: cadence to the nearest 5, resistance in blocks of 5', () => {
  assert.deepEqual(resistanceBlock(43.2), [40, 45]);
  assert.deepEqual(resistanceBlock(45), [45, 50]);
  assert.deepEqual(resistanceBlock(3), [1, 5]);
  assert.deepEqual(resistanceBlock(100), [95, 100]);
  assert.deepEqual(resistanceBlock(50, 50), [45, 50]); // never above a cap

  for (const type of ['hills', 'mountain', 'spinclass', 'fartlek']) {
    const w = generateWorkout(type, 45, 0);
    for (const seg of w.segments) {
      const t = stepTargets(seg, w.segments, 250, DEFAULT_MODEL);
      assert.equal(t.cadence % 5, 0, `${w.code} ${seg.label} cadence ${t.cadence}`);
      assert.equal(t.cadenceRange[0] % 5, 0);
      if (seg.creep) continue;
      const [lo, hi] = t.resistanceRange;
      assert.ok(lo === 1 || lo % 5 === 0, `${w.code} ${seg.label} block from ${lo}`);
      if (hi !== null) assert.ok(hi % 5 === 0 && t.resistance >= lo && t.resistance <= hi);
    }
  }
});

test('a creeping climb is called as one exact number, a level or two at a time', () => {
  const segs = [0, 1, 2, 3].map((i) => ({ kind: 'work', dur: 20, pct: 72 + i * 3.5, cadence: 80, creep: true, label: `Creep ${i + 1}/4` }));
  const ts = segs.map((seg) => stepTargets(seg, segs, 250, DEFAULT_MODEL));
  for (const t of ts) {
    assert.equal(t.resistanceIsExact, true);
    assert.deepEqual(t.resistanceRange, [t.resistance - 1, t.resistance + 1]);
  }
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i].resistance - ts[i - 1].resistance >= 1 && ts[i].resistance - ts[i - 1].resistance <= 3);
  assert.equal(spokenCue(segs[1], ts[1], 'resistance', segs[0]), `Resistance ${ts[1].resistance}.`);
});

test('the voice calls the resistance block', () => {
  const seg = { kind: 'work', dur: 120, label: 'Hill 2 of 7' };
  const tg = { resistance: 43, resistanceRange: [40, 45], cadence: 70, watts: 260 };
  assert.equal(spokenCue(seg, tg), 'Hill. Resistance 40 to 45, cadence 70.');
});
