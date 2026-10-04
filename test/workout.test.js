import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPES, DURATIONS, generateWorkout, parseWorkoutCode, workoutFromCode, segmentIndexAt, zoneOf, workoutStats,
} from '../src/core/workout.js';

test('every type, duration and variant fills the exact time with contiguous steps', () => {
  for (const t of TYPES) {
    for (const d of DURATIONS) {
      for (let v = 0; v < 3; v++) {
        const w = generateWorkout(t.id, d.min, v);
        assert.equal(w.totalS, d.min * 60, `${w.code} total`);
        let expect = 0;
        for (const s of w.segments) {
          assert.equal(s.start, expect, `${w.code} contiguous`);
          assert.ok(s.dur > 0, `${w.code} positive durations`);
          assert.ok(s.label, `${w.code} labelled`);
          expect += s.dur;
        }
        assert.equal(w.segments[0].kind, 'warmup');
        assert.equal(w.segments.at(-1).kind, 'cooldown');
      }
    }
  }
});

test('any custom length from 10 to 120 minutes fills the time exactly', () => {
  for (const t of TYPES) {
    for (let min = 10; min <= 120; min++) {
      for (let v = 0; v < 3; v++) {
        const w = generateWorkout(t.id, min, v);
        assert.equal(w.totalS, min * 60, `${w.code} total`);
        assert.ok(w.segments.every((s) => s.dur > 0), `${w.code} positive durations`);
        assert.deepEqual(parseWorkoutCode(w.code), { type: t.id, minutes: min, variant: v });
      }
    }
  }
});

test('same code, same workout', () => {
  const a = generateWorkout('pyramid', 45, 2);
  const b = workoutFromCode(a.code);
  assert.deepEqual(b, a);
});

test('codes round-trip and reject junk', () => {
  assert.deepEqual(parseWorkoutCode('int-30-k7q'), { type: 'intervals', minutes: 30, variant: 0 });
  assert.equal(parseWorkoutCode('INT-30-ZZZ'), null);
  assert.equal(parseWorkoutCode('hello'), null);
  assert.equal(parseWorkoutCode('INT-5-K7Q'), null);
});

test('30-minute intervals: four climbs, each ending in a 30 s gate', () => {
  const w = generateWorkout('intervals', 30, 0);
  const climbs = w.segments.filter((s) => s.kind === 'work');
  assert.equal(climbs.length, 4);
  assert.equal(climbs[2].label, 'Climb 3 of 4');
  assert.equal(w.gates.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(w.gates[i].end, climbs[i].start + climbs[i].dur);
    assert.equal(w.gates[i].end - w.gates[i].start, 30);
  }
});

test('sprints are gates in full', () => {
  const w = generateWorkout('sprints', 22, 0);
  const sprints = w.segments.filter((s) => s.kind === 'sprint');
  assert.ok(sprints.length >= 3);
  assert.equal(w.gates.length, sprints.length);
  assert.equal(w.gates[0].start, sprints[0].start);
});

test('cadence drills carry rpm targets', () => {
  const w = generateWorkout('cadence', 30, 1);
  const drills = w.segments.filter((s) => s.kind === 'drill');
  assert.ok(drills.length > 0);
  assert.ok(drills.every((s) => [70, 90, 110].includes(s.cadence)));
});

test('segmentIndexAt finds the active step', () => {
  const w = generateWorkout('intervals', 30, 0);
  const climb = w.segments.find((s) => s.kind === 'work');
  assert.equal(w.segments[segmentIndexAt(w, climb.start + 1)], climb);
  assert.equal(segmentIndexAt(w, -5), 0);
  assert.equal(segmentIndexAt(w, 1e9), w.segments.length - 1);
});

test('zones and stats', () => {
  assert.deepEqual([50, 70, 85, 100, 120].map(zoneOf), [1, 2, 3, 4, 5]);
  const s = workoutStats(generateWorkout('intervals', 30, 0), 200);
  assert.equal(s.hardMinutes, 12);
  assert.ok(s.avgTargetW > 100 && s.avgTargetW < 200);
  assert.ok(s.effort >= 1 && s.effort <= 10);
});
