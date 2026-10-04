import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkout, parseWorkoutCode, SPIN_BLOCKS } from '../src/core/workout.js';
import { excludeMask, excludeFromMask } from '../src/core/spinclass.js';
import { stepTargets, spokenCue, repeatsInBlock } from '../src/core/ride.js';
import { DEFAULT_MODEL } from '../src/core/resistance.js';

const main = (w) => w.segments.filter((s) => s.kind !== 'warmup' && s.kind !== 'cooldown');

/** The steps of the first `title` block found in any of a run of classes. */
function findBlock(title, type = 'spinclass') {
  for (let variant = 0; variant < 200; variant++) {
    const w = generateWorkout(type, 60, variant);
    const start = w.segments.findIndex((s) => s.blockStart && s.block === title);
    if (start < 0) continue;
    let end = start + 1;
    while (end < w.segments.length && w.segments[end].block === title && !w.segments[end].blockStart) end++;
    return { w, steps: w.segments.slice(start, end) };
  }
  throw new Error(`no class with a ${title} block`);
}

test('every step of a class belongs to a named block, and each block is introduced once', () => {
  const w = generateWorkout('spinclass', 45, 0);
  const titles = new Set([...SPIN_BLOCKS.map((b) => b.title), 'Recovery']);
  for (const s of main(w)) assert.ok(s.name === 'Cruise' || titles.has(s.block), s.label);
  assert.equal(main(w)[0].block, 'Flat road');
  assert.ok(main(w).filter((s) => s.blockStart).length >= 4);
});

test('a class is ridden in waves, with recoveries between them', () => {
  for (const variant of [0, 1, 2, 77]) {
    const w = generateWorkout('spinclass', 60, variant);
    assert.ok(w.segments.some((s) => s.block === 'Recovery'), w.code);
  }
});

test('a class ends on one of its hardest blocks, straight into the cool-down', () => {
  const finales = SPIN_BLOCKS.filter((b) => b.finale).map((b) => b.title);
  const lowFinales = SPIN_BLOCKS.filter((b) => b.lowFinale).map((b) => b.title);
  for (const variant of [0, 1, 2, 500, 9001, 31337]) {
    for (const [type, allowed] of [['spinclass', finales], ['spinlow', lowFinales]]) {
      const w = generateWorkout(type, 45, variant);
      const last = main(w).at(-1);
      assert.ok(allowed.includes(last.block), `${w.code} ends on ${last.block}`);
      assert.equal(w.segments[w.segments.indexOf(last) + 1].kind, 'cooldown');
    }
  }
});

test('standing and flat-out time are capped, apart from the finale', () => {
  for (let variant = 0; variant < 40; variant++) {
    const w = generateWorkout('spinclass', 60, variant);
    const steps = main(w);
    const finale = steps.at(-1).block;
    const lastStart = steps.map((s) => s.blockStart).lastIndexOf(true);
    const before = steps.slice(0, lastStart);
    const total = steps.reduce((a, s) => a + s.dur, 0);
    const standing = before.filter((s) => s.position === 'standing').reduce((a, s) => a + s.dur, 0);
    const allOut = before.filter((s) => s.kind === 'sprint' || s.pct >= 130).reduce((a, s) => a + s.dur, 0);
    assert.ok(standing <= total * 0.22 + 1, `${w.code}: ${standing}s standing before ${finale}`);
    assert.ok(allOut <= Math.max(60, total * 0.08) + 1, `${w.code}: ${allOut}s flat out before ${finale}`);
  }
});

test('blocks can be left out, and the code remembers which', () => {
  const exclude = ['sprints', 'jumps', 'tabata'];
  for (const variant of [0, 5, 4242]) {
    const w = generateWorkout('spinclass', 60, variant, { exclude });
    assert.ok(!w.segments.some((s) => ['Sprints', 'Jumps', 'Tabata'].includes(s.block)), w.code);
    const parsed = parseWorkoutCode(w.code);
    assert.deepEqual(parsed.exclude.sort(), [...exclude].sort());
    assert.deepEqual(generateWorkout(parsed.type, parsed.minutes, parsed.variant, parsed).segments, w.segments);
  }
  // Nothing left out: the code has no fourth part.
  assert.equal(generateWorkout('spinclass', 45, 0).code.split('-').length, 3);
  assert.deepEqual(excludeFromMask(excludeMask(['creep', 'flat', 'nonsense'])), ['creep']); // flat road is always in
  assert.equal(parseWorkoutCode('INT-30-K7Q-T4'), null); // only spin classes have blocks
});

test('the low impact class is seated, gentle, never sprints and keeps resistance at 50 or less', () => {
  const hardest = (w) => Math.max(...w.segments.map((s) => s.pct));
  for (const variant of [0, 1, 2, 404, 7777, 31337]) {
    const w = generateWorkout('spinlow', 45, variant);
    assert.ok(w.segments.every((s) => s.position === 'seated'), w.code);
    assert.ok(w.segments.every((s) => s.kind !== 'sprint' && s.cadence <= 100), w.code);
    assert.ok(hardest(w) <= 95, `${w.code} peaks at ${hardest(w)}`);
    assert.ok(hardest(w) < hardest(generateWorkout('spinclass', 45, variant)));
    assert.equal(w.segments.reduce((a, s) => a + s.dur, 0), 45 * 60);
    // Even for a very strong rider, whose targets would otherwise run higher.
    for (const s of main(w)) assert.ok(stepTargets(s, w.segments, 600, DEFAULT_MODEL).knob <= 50, `${w.code} ${s.label}`);
  }
});

test('cadence pushes hold the resistance and spin faster', () => {
  const { w, steps } = findBlock('Cadence pushes');
  const [settle, push] = steps;
  assert.equal(push.hold, true);
  assert.ok(push.cadence - settle.cadence >= 15 && push.cadence - settle.cadence <= 25);
  assert.equal(stepTargets(push, w.segments, 300, DEFAULT_MODEL).knob, stepTargets(settle, w.segments, 300, DEFAULT_MODEL).knob);
  assert.equal(steps.length, steps[0].rounds * 2);
});

test('resistance pushes hold the cadence and add resistance', () => {
  const { steps } = findBlock('Resistance pushes');
  const [settle, push] = steps;
  assert.equal(push.cadence, settle.cadence);
  assert.ok(push.pct > settle.pct + 15);
});

test('a creeping climb adds a little every 20 seconds', () => {
  const { steps } = findBlock('Creeping climb');
  assert.ok(steps.length >= 7 && steps.length <= 10);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].creep && steps[i].dur === 20 && steps[i].pct > steps[i - 1].pct && steps[i].cadence === steps[0].cadence);
  }
});

test('the standing ladder gets 15 seconds longer each time', () => {
  const { steps } = findBlock('Standing ladder');
  const stands = steps.filter((s) => s.position === 'standing');
  assert.ok(stands.length >= 3);
  for (let i = 1; i < stands.length; i++) assert.equal(stands[i].dur - stands[i - 1].dur, 15);
  assert.ok(steps.filter((s) => s.position === 'seated').every((s) => s.hold));
});

test('tabata is eight rounds of 20 on, 10 off', () => {
  const { steps } = findBlock('Tabata');
  const on = steps.filter((s) => s.kind === 'work');
  assert.equal(on.length, 8);
  assert.ok(on.every((s) => s.dur === 20 && s.pct >= 130));
  assert.ok(steps.filter((s) => s.kind === 'recovery').every((s) => s.dur === 10 && s.hold));
});

test('spin-ups climb through the cadences on one resistance', () => {
  const { w, steps } = findBlock('Spin-ups');
  const round = steps.slice(0, 4);
  assert.deepEqual(round.map((s) => s.cadence), [80, 90, 100, 110]);
  // Every stage, however far down the chain of held steps, uses the first one's resistance.
  const knob = stepTargets(round[0], w.segments, 300, DEFAULT_MODEL).knob;
  for (const s of steps) assert.equal(stepTargets(s, w.segments, 300, DEFAULT_MODEL).knob, knob, s.label);
});

test('a climb with attacks surges for 15 seconds each minute', () => {
  const { steps } = findBlock('Climb with attacks');
  const [climb, attack] = steps;
  assert.equal(climb.dur + attack.dur, 60);
  assert.equal(attack.dur, 15);
  assert.ok(attack.hold && attack.cadence > climb.cadence);
});

test('switchbacks alternate seated and standing every 30 seconds on one resistance', () => {
  const { steps } = findBlock('Switchbacks');
  assert.ok(steps.every((s) => s.dur === 30));
  assert.deepEqual(steps.slice(0, 4).map((s) => s.position), ['seated', 'standing', 'seated', 'standing']);
  assert.ok(steps.filter((s) => s.position === 'standing').every((s) => s.hold));
});

test('a time trial is one long hard seated effort', () => {
  const { steps } = findBlock('Time trial');
  assert.equal(steps.length, 1);
  assert.ok(steps[0].dur >= 240 && steps[0].position === 'seated' && steps[0].pct >= 90);
});

test('the first step of a block is introduced by name when spoken', () => {
  const tg = { knob: 31, cadence: 80, watts: 220 };
  const first = { kind: 'steady', dur: 45, label: 'Settle', block: 'Cadence pushes', blockStart: true, rounds: 4, position: 'seated' };
  assert.equal(spokenCue(first, tg), 'Cadence pushes, 4 rounds. Settle. Resistance 31, cadence 80.');
  assert.equal(spokenCue({ ...first, blockStart: false }, tg), 'Settle. Resistance 31, cadence 80.');
  const rest = { kind: 'recovery', dur: 180, label: 'Recover', block: 'Recovery', blockStart: true, position: 'seated' };
  assert.equal(spokenCue(rest, tg), 'Recover. Resistance 31, cadence 80.');
});

test('a block gives its numbers once, then just names the steps it repeats', () => {
  const { w, steps } = findBlock('Cadence pushes');
  const at = (seg) => w.segments.indexOf(seg);
  const say = (seg) => spokenCue(seg, stepTargets(seg, w.segments, 300, DEFAULT_MODEL), 'knob', w.segments[at(seg) - 1], repeatsInBlock(w.segments, at(seg)));
  assert.match(say(steps[0]), /^Cadence pushes, \d rounds\. Settle\. Resistance \d+, cadence \d+\.$/);
  assert.match(say(steps[1]), /^Cadence push\. Same resistance, cadence \d+\.$/);
  assert.equal(say(steps[2]), 'Settle.');
  assert.equal(say(steps[3]), 'Cadence push.');
});

test('blocks that open on a short step still say their numbers, and titles are not repeated', () => {
  const tg = { knob: 60, cadence: 100, watts: 460 };
  const tabata = { kind: 'work', dur: 20, label: 'Tabata 1/8', block: 'Tabata', blockStart: true, rounds: 8, position: 'seated' };
  assert.equal(spokenCue(tabata, tg), 'Tabata, 8 rounds. Resistance 60, cadence 100. Go.');
  assert.equal(spokenCue({ ...tabata, blockStart: false, label: 'Tabata 2/8' }, tg, 'knob', { dur: 10 }), 'Go.');
  const trial = { kind: 'work', dur: 300, label: 'Time trial', name: 'Time trial', block: 'Time trial', blockStart: true, position: 'seated' };
  assert.equal(spokenCue(trial, tg), 'Time trial. Resistance 60, cadence 100.');
  const bend = { kind: 'work', dur: 30, label: 'Switchback 1 of 4', name: 'Switchback', block: 'Switchbacks', blockStart: true, rounds: 4, position: 'seated' };
  assert.equal(spokenCue(bend, tg), 'Switchbacks, 4 rounds. Resistance 60, cadence 100.');
  const spin = { kind: 'drill', dur: 20, label: 'Spin-up 2 of 8', name: 'Spin-up', hold: true, block: 'Spin-ups', position: 'seated' };
  assert.equal(spokenCue(spin, { knob: 23, cadence: 90, watts: 150 }, 'knob', { dur: 20 }), 'Cadence 90.');
  assert.equal(spokenCue({ ...spin, hold: false, blockStart: true, rounds: 2 }, { knob: 23, cadence: 80, watts: 120 }), 'Spin-ups, 2 rounds. Resistance 23, cadence 80.');
  const attack = { kind: 'work', dur: 15, label: 'Attack 1 of 4', name: 'Attack', hold: true, block: 'Climb with attacks', position: 'seated' };
  assert.equal(spokenCue(attack, tg), 'Same resistance, cadence 100. Attack.');
  assert.equal(spokenCue(attack, tg, 'knob', null, true), 'Attack.');
  const last = { kind: 'sprint', dur: 60, label: 'Last push', name: 'Last push', block: 'Last push', blockStart: true, position: 'seated' };
  assert.equal(spokenCue(last, tg), 'Last push. All out.');
});
