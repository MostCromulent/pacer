import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkout } from '../src/core/workout.js';
import { DEFAULT_MODEL } from '../src/core/resistance.js';
import { pacerGhost } from '../src/core/ghost.js';
import { RideSession } from '../src/core/ride.js';
import { rideReview, rideSpans, rideVerdict } from '../src/core/review.js';

// Ride a workout following the targets, except where `adjust` changes the reading.
function ride(workout, adjust = (reading) => reading, { until = Infinity, effortAt } = {}) {
  const s = new RideSession({ workout, baselineW: 200, model: DEFAULT_MODEL, ghost: pacerGhost(workout, 200) });
  while (!s.done && s.t < until) {
    if (effortAt && s.t >= effortAt[0]) s.setEffort(effortAt[1]);
    const seg = s.snapshot().seg;
    const tg = s.targetsFor(seg);
    const { cadence, resistance } = adjust({ cadence: tg.cadence, resistance: tg.resistance }, seg);
    s.setInput({ cadence, resistance, powerW: 0.1 }); // power is not what is being followed here
    s.update(0.5);
  }
  return s;
}

test('a spin class is reviewed block by block, in order', () => {
  const w = generateWorkout('spinclass', 30, 0);
  const spans = rideSpans(w);
  assert.equal(spans[0].name, 'Warm-up');
  assert.equal(spans.at(-1).name, 'Cool-down');
  assert.equal(spans[0].from, 0);
  assert.equal(spans.at(-1).to, w.totalS);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i].from, spans[i - 1].to);

  const r = rideReview(ride(w));
  assert.equal(r.seconds, w.totalS);
  assert.deepEqual(r.rows.map((x) => x.name), spans.map((x) => x.name));
  assert.deepEqual(r.misses, []);
  for (const row of r.rows) {
    assert.ok(row.onTargetPct >= 90, `${row.name} ${row.onTargetPct}%`);
    assert.equal(row.cadenceOff, 0);
    assert.equal(row.resistanceOff, 0);
  }
});

test('other rides gather their repeats into one line each', () => {
  const w = generateWorkout('intervals', 30, 0);
  const names = rideReview(ride(w)).rows.map((x) => x.name);
  assert.deepEqual(names, ['Warm-up', 'Climb ×4', 'Recover ×4', 'Cruise', 'Cool-down']);
});

test('a stretch ridden short of the target shows as a miss and in its block', () => {
  const w = generateWorkout('intervals', 30, 0);
  const second = w.segments.filter((s) => s.kind === 'work')[1];
  const s = ride(w, (reading, seg) => (seg === second ? { ...reading, resistance: reading.resistance - 12 } : reading));
  const r = rideReview(s);
  assert.equal(r.misses.length, 1);
  const [from, to] = r.misses[0];
  assert.ok(from >= second.start && from <= second.start + 10, `from ${from}`); // after a few seconds' grace
  assert.ok(Math.abs(to - (second.start + second.dur)) <= 1, `to ${to}`);
  const climbs = r.rows.find((x) => x.name.startsWith('Climb'));
  assert.ok(climbs.resistanceOff < 0);
  assert.ok(climbs.onTargetPct < 80 && climbs.onTargetPct > 60);
  assert.equal(r.rows.find((x) => x.name.startsWith('Recover')).resistanceOff, 0);
});

test('targets follow the effort setting at the time', () => {
  const w = generateWorkout('endurance', 20, 0);
  const s = ride(w, undefined, { effortAt: [600, 1.3] });
  const r = rideReview(s);
  assert.ok(r.targets[900].resistance > r.targets[500].resistance);
  assert.deepEqual(r.misses, []);
});

test('a ride ended early is reviewed as far as it went', () => {
  const w = generateWorkout('spinclass', 30, 0);
  const r = rideReview(ride(w, undefined, { until: 400 }));
  assert.equal(r.seconds, 400);
  assert.ok(r.rows.length >= 1 && r.rows.length < rideSpans(w).length);
});

test('recoveries are not scored, and the verdict says where it went best and worst', () => {
  const w = generateWorkout('intervals', 30, 0);
  const second = w.segments.filter((s) => s.kind === 'work')[1];
  const r = rideReview(ride(w, (reading, seg) => (seg === second ? { ...reading, resistance: reading.resistance - 14 } : reading)));
  assert.equal(r.rows.find((x) => x.name.startsWith('Recover')).rest, true);
  assert.equal(r.rows.find((x) => x.name.startsWith('Climb')).rest, false);
  assert.ok(r.spans.some((sp) => sp.rest) && r.spans.some((sp) => !sp.rest));
  for (const sp of r.spans) assert.ok(sp.onTargetPct >= 0 && sp.onTargetPct <= 100);
  assert.match(rideVerdict(r), /^Best held: .+ \(\d+%\)\. Hardest to hold: Climb ×4 \(\d+%\), where the resistance ran a little low\.$/);
  // Held throughout, there is only one thing to say; with nothing to compare, nothing.
  assert.equal(rideVerdict(rideReview(ride(w))), 'On target all the way through.');
  assert.equal(rideVerdict({ rows: [{ name: 'Cruise', onTargetPct: 80 }] }), '');
});
