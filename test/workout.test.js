import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPES, DURATIONS, generateWorkout, parseWorkoutCode, segmentIndexAt, zoneOf, workoutStats, randomVariant, VARIANT_CODES,
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
        assert.ok(w.segments.every((s) => s.cadence >= 60 && s.cadence <= 120), `${w.code} cadence targets`);
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
  const { type, minutes, variant } = parseWorkoutCode(a.code);
  const b = generateWorkout(type, minutes, variant);
  assert.deepEqual(b, a);
});

test('codes round-trip and reject junk', () => {
  assert.deepEqual(parseWorkoutCode('int-30-k7q'), { type: 'intervals', minutes: 30, variant: 0 });
  // Any other three characters are a random version, not junk.
  assert.equal(parseWorkoutCode('INT-30-ZZZ').variant, 3 + 36 ** 3 - 1);
  assert.equal(parseWorkoutCode('QQQ-30-K7Q'), null);
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
  assert.equal(s.hardMinutes, 14);
  assert.ok(s.avgTargetW > 100 && s.avgTargetW < 200);
  assert.ok(s.score >= 1 && s.score <= 10);
});

test('workout types are grouped and include natural styles, HIIT and mixes', () => {
  const groups = new Set(TYPES.map((t) => t.group));
  assert.deepEqual([...groups], ['Spin class', 'Steady', 'Natural', 'Intervals', 'Mixed']);
  for (const id of ['hills', 'mountain', 'fartlek', 'hiit', 'recovery', 'spinclass']) assert.ok(TYPES.some((t) => t.id === id), id);
  assert.equal(new Set(TYPES.map((t) => t.code)).size, TYPES.length);
});

test('HIIT is built from short reps with rests between blocks', () => {
  const w = generateWorkout('hiit', 30, 0);
  const reps = w.segments.filter((s) => s.kind === 'work');
  assert.equal(reps.length % 8, 0);
  assert.ok(reps.every((s) => s.dur === 20 && s.pct > 130));
  assert.match(reps[8].label, /^Tabata 2 · rep 1\/8$/);
  assert.ok(w.segments.some((s) => s.label === 'Rest' && s.dur === 180));
  assert.equal(w.gates.length, 0);
});

test('every HIIT ride finishes on a Tabata, whatever its blocks', () => {
  for (let v = 0; v < 3; v++) {
    for (let min = 12; min <= 120; min += 3) {
      const w = generateWorkout('hiit', min, v);
      const reps = w.segments.filter((s) => s.kind === 'work');
      assert.ok(reps.length >= 8, `${w.code} has no blocks`);
      const last = reps.slice(-8);
      assert.ok(last.every((s) => s.dur === 20 && /^Tabata/.test(s.label)), `${w.code} ends on ${reps.at(-1).label}`);
      // ...and goes straight from its last rest into the cool-down.
      const cool = w.segments.findIndex((s) => s.kind === 'cooldown');
      assert.equal(w.segments[cool - 2], last.at(-1), `${w.code} has something between the Tabata and the cool-down`);
    }
  }
  // The other versions ride their own blocks first, then the Tabata.
  const w = generateWorkout('hiit', 45, 1);
  const labels = w.segments.filter((s) => s.kind === 'work').map((s) => s.label);
  assert.match(labels[0], /^30\/30 1 · rep 1\/10$/);
  assert.equal(labels.at(-1), 'Tabata · rep 8/8');
});

test('natural rides vary like terrain but repeat exactly for the same code', () => {
  const a = generateWorkout('hills', 45, 0);
  const hills = a.segments.filter((s) => s.name === 'Hill');
  assert.ok(hills.length >= 4);
  assert.ok(new Set(hills.map((s) => s.dur)).size > 1, 'hill lengths vary');
  assert.ok(new Set(hills.map((s) => s.pct)).size > 1, 'hill steepness varies');
  assert.deepEqual(generateWorkout('hills', 45, 0), a);
  assert.notDeepEqual(generateWorkout('hills', 45, 1).segments, a.segments);
});

test('mountains climb in steps that get harder, with a gate only at the summit', () => {
  const w = generateWorkout('mountain', 45, 0);
  const climbs = w.segments.filter((s) => /^Mountain 1 · climb/.test(s.label));
  for (let i = 1; i < climbs.length; i++) assert.ok(climbs[i].pct > climbs[i - 1].pct);
  const summits = w.segments.filter((s) => /summit$/.test(s.label));
  assert.equal(w.gates.length, summits.length);
  summits.forEach((s, i) => assert.equal(w.gates[i].end, s.start + s.dur));
});

test('mix pairs a natural first half with an interval second half', () => {
  const w = generateWorkout('mix', 45, 0);
  assert.equal(w.name, 'Mix: rolling hills + HIIT');
  const firstHill = w.segments.findIndex((s) => s.name === 'Hill');
  const firstRep = w.segments.findIndex((s) => /^Tabata/.test(s.label ?? ''));
  assert.ok(firstHill >= 0 && firstRep > firstHill);
  assert.equal(generateWorkout('mix', 45, 1).name, 'Mix: mountain + sprints');
});

test('a higher effort setting means more hard minutes and a higher average', () => {
  const w = generateWorkout('intervals', 30, 0);
  const easy = workoutStats(w, 200, 0.8);
  const normal = workoutStats(w, 200);
  const hard = workoutStats(w, 200, 1.2);
  assert.ok(easy.hardMinutes < normal.hardMinutes && normal.hardMinutes <= hard.hardMinutes);
  assert.ok(easy.avgTargetW < normal.avgTargetW && normal.avgTargetW < hard.avgTargetW);
});

test('natural rides vary: hills, descents and flats are not all alike', () => {
  const w = generateWorkout('hills', 45, 0);
  const distinct = (name, key) => new Set(w.segments.filter((s) => s.name === name).map((s) => s[key])).size;
  assert.ok(distinct('Hill', 'pct') > 2 && distinct('Hill', 'cadence') > 1);
  assert.ok(distinct('Descent', 'pct') > 1 && distinct('Descent', 'cadence') > 1);
  // Still the same ride every time for the same code.
  assert.deepEqual(generateWorkout('hills', 45, 0).segments, w.segments);
  const m = generateWorkout('mountain', 45, 0);
  const climbs = m.segments.filter((s) => /Mountain 1 · climb/.test(s.label));
  for (let i = 1; i < climbs.length; i++) assert.ok(climbs[i].pct > climbs[i - 1].pct, 'mountain steps still rise');
});

test('warm-up and cool-down are capped at five minutes', () => {
  for (const minutes of [22, 45, 90, 120]) {
    const w = generateWorkout('endurance', minutes, 0);
    const count = (kind) => w.segments.filter((s) => s.kind === kind).reduce((a, s) => a + s.dur, 0) / 60;
    assert.ok(count('warmup') >= 2 && count('warmup') <= 5, `warm-up at ${minutes}`);
    assert.ok(count('cooldown') >= 2 && count('cooldown') <= 5, `cool-down at ${minutes}`);
  }
});

test('a longer ride has longer efforts and more of them, in sets', () => {
  const efforts = (minutes) => generateWorkout('intervals', minutes, 0).segments.filter((s) => s.kind === 'work');
  const [short, mid, long] = [22, 45, 90].map(efforts);
  assert.ok(short[0].dur < mid[0].dur && mid[0].dur < long[0].dur, 'efforts get longer');
  assert.ok(short.length < mid.length && mid.length < long.length, 'and there are more of them');
  const spells = (minutes) => generateWorkout('intervals', minutes, 0).segments.filter((s) => s.name === 'Easy spell').length;
  assert.equal(spells(22), 0);
  assert.ok(spells(90) >= 1, 'long rides are split into sets');
});

test('pyramid repeats its ladder on long rides instead of cruising', () => {
  const w = generateWorkout('pyramid', 90, 0);
  const cruise = w.segments.filter((s) => s.name === 'Cruise').reduce((a, s) => a + s.dur, 0);
  assert.ok(cruise <= 10 * 60, `cruise ${cruise / 60} min`);
  assert.ok(w.segments.filter((s) => s.name === 'Easy spell').length >= 2);
});

test('low impact stays moderate, seated and free of sprint gates', () => {
  for (const v of [0, 1, 2]) {
    const w = generateWorkout('lowimpact', 30, v);
    assert.ok(w.segments.every((s) => s.pct <= 82 && s.kind !== 'sprint' && s.kind !== 'work'), w.code);
    assert.equal(w.gates.length, 0);
    assert.ok(w.segments.some((s) => s.name === 'Gentle rise'));
  }
});

test('progression only ever gets harder, with no recoveries', () => {
  for (const minutes of [22, 45, 90]) {
    const w = generateWorkout('progression', minutes, 0);
    const main = w.segments.filter((s) => /^Build/.test(s.label));
    assert.ok(main.length >= 3);
    for (let i = 1; i < main.length; i++) assert.ok(main[i].pct > main[i - 1].pct, `step ${i} at ${minutes}`);
    assert.ok(!w.segments.some((s) => s.kind === 'recovery'));
  }
});

test('climb repeats are the same slow, heavy hill each time', () => {
  const w = generateWorkout('climbs', 45, 0);
  const climbs = w.segments.filter((s) => s.kind === 'work');
  assert.ok(climbs.length >= 3);
  assert.equal(new Set(climbs.map((s) => `${s.dur}/${s.pct}/${s.cadence}`)).size, 1);
  assert.ok(climbs[0].cadence <= 66);
});

test('every step is seated or standing, and only the steep slow ones stand', () => {
  for (const t of TYPES) {
    const w = generateWorkout(t.id, 45, 1);
    assert.ok(w.segments.every((s) => s.position === 'seated' || s.position === 'standing'), w.code);
  }
  assert.ok(generateWorkout('lowimpact', 45, 0).segments.every((s) => s.position === 'seated'));
  const spin = generateWorkout('spinclass', 45, 0);
  assert.ok(spin.segments.filter((s) => s.position === 'standing').every((s) => /Standing climb|Jump|Stand|Heavy push|Sprint|Last push/.test(s.label)));
});

test('random versions have their own codes, and the same code is the same ride', () => {
  const variant = randomVariant(() => 0.4321);
  assert.ok(variant >= 3);
  const w = generateWorkout('spinclass', 45, variant);
  assert.deepEqual(parseWorkoutCode(w.code), { type: 'spinclass', minutes: 45, variant });
  assert.deepEqual(generateWorkout('spinclass', 45, variant).segments, w.segments);
  assert.ok(!VARIANT_CODES.includes(w.code.split('-')[2]));
});

test('a short ride has a short warm-up, and a gentle ride a shorter one still', () => {
  const warmUp = (type, minutes) => generateWorkout(type, minutes, 0).segments.filter((s) => s.kind === 'warmup').reduce((a, s) => a + s.dur, 0) / 60;
  assert.equal(warmUp('spinlow', 18), 1);
  assert.equal(warmUp('lowimpact', 18), 1);
  assert.equal(warmUp('recovery', 30), 2);
  assert.equal(warmUp('spinlow', 60), 3);
  assert.equal(warmUp('spinclass', 18), 2);
  assert.equal(warmUp('intervals', 30), 3);
  assert.equal(warmUp('hills', 60), 5);
  // The cool-down is the same length.
  const coolDown = (type, minutes) => generateWorkout(type, minutes, 0).segments.filter((s) => s.kind === 'cooldown').reduce((a, s) => a + s.dur, 0) / 60;
  assert.equal(coolDown('spinlow', 15), 1);
  assert.equal(coolDown('spinlow', 45), 3);
  assert.equal(coolDown('spinclass', 30), 3);
});

test('random spin classes differ, but always warm up, cool down and add up', () => {
  const shapes = new Set();
  for (let i = 0; i < 40; i++) {
    const w = generateWorkout('spinclass', 45, 3 + i * 977);
    assert.equal(w.segments.reduce((a, s) => a + s.dur, 0), 45 * 60);
    const mins = (kind) => w.segments.filter((s) => s.kind === kind).reduce((a, s) => a + s.dur, 0) / 60;
    assert.ok(mins('warmup') >= 3 && mins('cooldown') >= 3, w.code);
    assert.equal(w.segments[0].kind, 'warmup');
    assert.equal(w.segments.at(-1).kind, 'cooldown');
    assert.ok(w.segments.every((s) => s.cadence >= 60 && s.cadence <= 120 && s.pct <= 150), w.code);
    shapes.add(w.segments.map((s) => `${s.label}:${s.dur}`).join('|'));
  }
  assert.ok(shapes.size >= 38, `only ${shapes.size} distinct classes`);
});

test('two steps in a row that look the same are one step', () => {
  for (const t of TYPES) {
    for (const minutes of [18, 30, 45, 60]) {
      for (const variant of [0, 1, 2, 77]) {
        const w = generateWorkout(t.id, minutes, variant);
        assert.equal(w.segments.reduce((a, s) => a + s.dur, 0), minutes * 60, w.code);
        for (let i = 1; i < w.segments.length; i++) {
          const [a, b] = [w.segments[i - 1], w.segments[i]];
          if (a.hold || b.hold || a.creep || b.creep || b.rounds) continue;
          const same = a.kind === b.kind && a.label === b.label && a.position === b.position
            && Math.round(a.cadence / 5) === Math.round(b.cadence / 5) && Math.abs(a.pct - b.pct) <= 5;
          assert.ok(!same, `${w.code}: ${a.label} (${a.dur}s, ${a.pct}%) then the same again (${b.dur}s, ${b.pct}%)`);
        }
      }
    }
  }
});

test('a recovery spin changes cadence between its spells', () => {
  const spells = generateWorkout('recovery', 45, 0).segments.filter((s) => s.kind === 'steady');
  assert.ok(spells.length >= 3);
  for (let i = 1; i < spells.length; i++) assert.notEqual(spells[i].cadence, spells[i - 1].cadence);
  assert.ok(spells.every((s) => s.cadence >= 70 && s.cadence <= 80 && s.pct <= 55));
});
