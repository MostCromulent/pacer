import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkout, parseWorkoutCode, SPIN_BLOCKS } from '../src/core/workout.js';
import { excludeMask, excludeFromMask, makeBlock, measureSteps, focusOf, fatigueAfter, restFor, inWaves, sameness, spreadLeftover } from '../src/core/spinclass.js';
import { stepTargets } from '../src/core/ride.js';
import { spokenCue, repeatsInBlock } from '../src/core/cues.js';
import { DEFAULT_MODEL, powerFor } from '../src/core/resistance.js';

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
  const titles = new Set(SPIN_BLOCKS.map((b) => b.title).concat('Recovery'));
  for (const s of main(w)) assert.ok(titles.has(s.block), s.label);
  assert.equal(main(w)[0].block, 'Flat road');
  assert.ok(main(w).filter((s) => s.blockStart).length >= 4);
});

test('a class is ridden in waves, with recoveries between them', () => {
  for (const variant of [0, 1, 2, 77]) {
    const w = generateWorkout('spinclass', 60, variant);
    assert.ok(w.segments.some((s) => s.block === 'Recovery'), w.code);
  }
});

// How hard a block is: its average effort, lifted towards its hardest step.
const hardness = (steps) => {
  const mean = steps.reduce((a, s) => a + s.dur * s.pct, 0) / steps.reduce((a, s) => a + s.dur, 0);
  return mean + 0.3 * (Math.max(...steps.map((s) => s.pct)) - mean);
};
const blocksOf = (w) => {
  const blocks = [];
  for (const seg of main(w)) {
    if (seg.blockStart) blocks.push({ name: seg.block, rounds: seg.rounds, steps: [] });
    blocks.at(-1).steps.push(seg);
  }
  return blocks;
};

test('a class ends on its hardest block, straight into the cool-down', () => {
  for (const type of ['spinclass', 'spinlow']) {
    for (const minutes of [30, 45, 60]) {
      for (let variant = 0; variant < 30; variant++) {
        const w = generateWorkout(type, minutes, variant);
        const blocks = blocksOf(w);
        const finale = blocks.at(-1);
        // Joining a block on to the one before can shift its efforts by a point or two.
        for (const b of blocks.slice(0, -1)) assert.ok(hardness(b.steps) <= hardness(finale.steps) + 3, `${w.code}: ${b.name} is harder than the finale, ${finale.name}`);
        assert.equal(w.segments[w.segments.indexOf(finale.steps.at(-1)) + 1].kind, 'cooldown');
        // Easy riding leads in to it: a spell of its own, or the recovery the block before ends on.
        const before = blocks.at(-2).steps.at(-1);
        assert.ok(before.pct <= 70 && before.dur >= 60, `${w.code}: no lead-in before ${finale.name}`);
      }
    }
  }
});

test('versions of a class are about as hard as each other', () => {
  for (const [type, minutes] of [['spinclass', 30], ['spinclass', 45], ['spinclass', 60], ['spinlow', 45]]) {
    const means = [];
    for (let variant = 0; variant < 60; variant++) {
      const steps = main(generateWorkout(type, minutes, variant));
      means.push(steps.reduce((a, s) => a + s.dur * s.pct, 0) / steps.reduce((a, s) => a + s.dur, 0));
    }
    assert.ok(Math.max(...means) - Math.min(...means) <= 10, `${type} ${minutes}: average effort runs from ${Math.min(...means).toFixed(1)} to ${Math.max(...means).toFixed(1)}`);
  }
});

test('the class builds: its second half is harder than its first', () => {
  let builds = 0;
  const classes = 60;
  for (let variant = 0; variant < classes; variant++) {
    const blocks = blocksOf(generateWorkout('spinclass', 60, variant)).filter((b) => !['Recovery', 'Flat road'].includes(b.name));
    const half = Math.floor(blocks.length / 2);
    const avg = (list) => list.reduce((a, b) => a + hardness(b.steps), 0) / list.length;
    if (avg(blocks.slice(half)) > avg(blocks.slice(0, half))) builds++;
  }
  assert.ok(builds >= classes * 0.9, `only ${builds} of ${classes} classes build`);
});

test('a longer class has more rounds in its blocks, and a short one still fits', () => {
  const rounds = (minutes) => {
    const all = [];
    for (let variant = 0; variant < 40; variant++) for (const b of blocksOf(generateWorkout('spinclass', minutes, variant))) if (b.rounds && b.name !== 'Tabata') all.push(b.rounds);
    return all.reduce((a, b) => a + b, 0) / all.length;
  };
  assert.ok(rounds(60) > rounds(22) + 0.4, `${rounds(22).toFixed(2)} rounds at 22 minutes, ${rounds(60).toFixed(2)} at 60`);
  for (let variant = 0; variant < 40; variant++) {
    const w = generateWorkout('spinclass', 10, variant);
    assert.equal(w.segments.reduce((a, s) => a + s.dur, 0), 600);
    assert.ok(w.segments.every((s) => s.dur > 0));
  }
});

test('the low impact class has gentle forms of blocks, under their own names', () => {
  const names = new Set();
  for (let variant = 0; variant < 60; variant++) for (const b of blocksOf(generateWorkout('spinlow', 60, variant))) names.add(b.name);
  for (const name of ['Surges', 'Seated ladder', 'Heavy pushes']) assert.ok(names.has(name), name);
  for (const name of ['Sprints', 'Standing ladder', 'Tabata', 'Jumps', 'Switchbacks', 'Standing climb', 'Last push']) assert.ok(!names.has(name), name);
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
    for (const s of main(w)) assert.ok(stepTargets(s, w.segments, 600, DEFAULT_MODEL).resistance <= 50, `${w.code} ${s.label}`);
  }
});

test('cadence pushes hold the resistance and spin faster', () => {
  const { w, steps } = findBlock('Cadence pushes');
  const [settle, push] = steps;
  assert.equal(push.hold, true);
  assert.ok(push.cadence - settle.cadence >= 10 && push.cadence - settle.cadence <= 20);
  assert.equal(stepTargets(push, w.segments, 300, DEFAULT_MODEL).resistance, stepTargets(settle, w.segments, 300, DEFAULT_MODEL).resistance);
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
  // Sitting between is a real let-up: resistance comes off and the legs keep turning.
  const sits = steps.filter((s) => s.position === 'seated');
  assert.ok(sits.every((s) => s.cadence >= 70 && s.pct <= 70));
});

test('tabata is eight rounds of 20 on, 10 off', () => {
  const { steps } = findBlock('Tabata');
  const on = steps.filter((s) => s.kind === 'work');
  assert.equal(on.length, 8);
  assert.ok(on.every((s) => s.dur === 20 && s.pct >= 120 && s.pct < 130));
  assert.ok(steps.filter((s) => s.kind === 'recovery').every((s) => s.dur === 10 && s.hold));
});

test('spin-ups climb through the cadences on one resistance', () => {
  const { w, steps } = findBlock('Spin-ups');
  const round = steps.slice(0, 4);
  assert.deepEqual(round.map((s) => s.cadence), [80, 90, 100, 110]);
  // Every stage, however far down the chain of held steps, uses the first one's resistance.
  const resistance = stepTargets(round[0], w.segments, 300, DEFAULT_MODEL).resistance;
  for (const s of steps) assert.equal(stepTargets(s, w.segments, 300, DEFAULT_MODEL).resistance, resistance, s.label);
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
  const tg = { resistance: 31, cadence: 80, watts: 220 };
  const first = { kind: 'steady', dur: 45, label: 'Settle', block: 'Cadence pushes', blockStart: true, rounds: 4, position: 'seated' };
  assert.equal(spokenCue(first, tg), 'Cadence pushes, 4 rounds. Settle. Resistance 31, cadence 80.');
  assert.equal(spokenCue({ ...first, blockStart: false }, tg), 'Settle. Resistance 31, cadence 80.');
  const rest = { kind: 'recovery', dur: 180, label: 'Recover', block: 'Recovery', blockStart: true, position: 'seated' };
  assert.equal(spokenCue(rest, tg), 'Recover. Resistance 31, cadence 80.');
});

test('a block gives its numbers once, then just names the steps it repeats', () => {
  const { w, steps } = findBlock('Cadence pushes');
  const at = (seg) => w.segments.indexOf(seg);
  const say = (seg) => spokenCue(seg, stepTargets(seg, w.segments, 300, DEFAULT_MODEL), 'resistance', w.segments[at(seg) - 1], repeatsInBlock(w.segments, at(seg)));
  assert.match(say(steps[0]), /^Cadence pushes, \d rounds\. Settle\. Resistance \d+ to \d+, cadence \d+\.$/);
  assert.match(say(steps[1]), /^Cadence push\. Same resistance, cadence \d+\.$/);
  assert.equal(say(steps[2]), 'Settle.');
  assert.equal(say(steps[3]), 'Cadence push.');
});

test('blocks that open on a short step still say their numbers, and titles are not repeated', () => {
  const tg = { resistance: 60, cadence: 100, watts: 460 };
  const tabata = { kind: 'work', dur: 20, label: 'Tabata 1/8', block: 'Tabata', blockStart: true, rounds: 8, position: 'seated' };
  assert.equal(spokenCue(tabata, tg), 'Tabata, 8 rounds. Resistance 60, cadence 100. Go.');
  assert.equal(spokenCue({ ...tabata, blockStart: false, label: 'Tabata 2/8' }, tg, 'resistance', { dur: 10 }), 'Go.');
  const trial = { kind: 'work', dur: 300, label: 'Time trial', name: 'Time trial', block: 'Time trial', blockStart: true, position: 'seated' };
  assert.equal(spokenCue(trial, tg), 'Time trial. Resistance 60, cadence 100.');
  const bend = { kind: 'work', dur: 30, label: 'Switchback 1 of 4', name: 'Switchback', block: 'Switchbacks', blockStart: true, rounds: 4, position: 'seated' };
  assert.equal(spokenCue(bend, tg), 'Switchbacks, 4 rounds. Resistance 60, cadence 100.');
  const spin = { kind: 'drill', dur: 20, label: 'Spin-up 2 of 8', name: 'Spin-up', hold: true, block: 'Spin-ups', position: 'seated' };
  assert.equal(spokenCue(spin, { resistance: 23, cadence: 90, watts: 150 }, 'resistance', { dur: 20 }), 'Cadence 90.');
  assert.equal(spokenCue({ ...spin, hold: false, blockStart: true, rounds: 2 }, { resistance: 23, cadence: 80, watts: 120 }), 'Spin-ups, 2 rounds. Resistance 23, cadence 80.');
  const attack = { kind: 'work', dur: 15, label: 'Attack 1 of 4', name: 'Attack', hold: true, block: 'Climb with attacks', position: 'seated' };
  assert.equal(spokenCue(attack, tg), 'Same resistance, cadence 100. Attack.');
  assert.equal(spokenCue(attack, tg, 'resistance', null, true), 'Attack.');
  const last = { kind: 'sprint', dur: 60, label: 'Last push', name: 'Last push', block: 'Last push', blockStart: true, position: 'seated' };
  assert.equal(spokenCue(last, tg), 'Last push. All out.');
});

test('two blocks of pushes never run back to back', () => {
  for (const type of ['spinclass', 'spinlow']) {
    for (const minutes of [22, 30, 45, 60]) {
      for (let variant = 0; variant < 40; variant++) {
        const w = generateWorkout(type, minutes, variant);
        const blocks = [];
        for (const seg of w.segments) {
          if (!blocks.length || seg.blockStart || seg.block !== blocks.at(-1).name) blocks.push({ name: seg.block, rounds: seg.rounds, steps: [] });
          blocks.at(-1).steps.push(seg);
        }
        for (let i = 1; i < blocks.length; i++) {
          const before = blocks[i - 1], last = before.steps.at(-1);
          if (!before.rounds || !blocks[i].rounds) continue;
          assert.ok(last.kind === 'recovery' && last.dur >= 60, `${w.code}: ${before.name} runs straight into ${blocks[i].name}`);
        }
      }
    }
  }
});

test('a step that holds the resistance is planned at the effort it really takes', () => {
  // Checked on a bike like the one the planner assumes, where watts rise with cadence to the power 1.6.
  const bike = { ...DEFAULT_MODEL, b: 1.6 };
  const real = (w, seg, baselineW = 300) => (stepTargets(seg, w.segments, baselineW, bike).watts / baselineW) * 100;
  for (const title of ['Cadence pushes', 'Jumps', 'Tabata', 'Climb with attacks', 'Switchbacks', 'Spin-ups']) {
    const { w, steps } = findBlock(title);
    for (const seg of steps.filter((x) => x.hold)) {
      assert.ok(Math.abs(real(w, seg) - seg.pct) <= 6, `${title} ${seg.label}: planned ${seg.pct}%, really ${real(w, seg).toFixed(0)}%`);
    }
  }
  // So a jump's settle and a Tabata's rest are easier than the work, not harder.
  const jumps = findBlock('Jumps').steps;
  assert.ok(jumps[1].pct < jumps[0].pct - 8);
  const tabata = findBlock('Tabata').steps;
  assert.ok(tabata[1].pct < 70);
});

test('no single step outstays its welcome, however long the class', () => {
  for (const type of ['spinclass', 'spinlow']) {
    for (let variant = 0; variant < 40; variant++) {
      const w = generateWorkout(type, 90, variant);
      for (const seg of main(w)) {
        if (seg.position === 'standing') assert.ok(seg.dur <= 180, `${w.code}: ${seg.dur}s standing in ${seg.block}`);
        if (seg.kind === 'recovery') assert.ok(seg.dur <= 150, `${w.code}: ${seg.dur}s recovery`);
        if (seg.block === 'Time trial') assert.ok(seg.dur <= 420, `${w.code}: ${seg.dur}s time trial`);
      }
      const opener = blocksOf(w)[0];
      assert.ok(opener.steps[0].dur <= 180, `${w.code}: opens with ${opener.steps[0].dur}s of flat road`);
    }
  }
});

test('a block that ends hard is followed by something easier', () => {
  for (let variant = 0; variant < 60; variant++) {
    const w = generateWorkout('spinclass', 60, variant);
    const blocks = blocksOf(w);
    for (let i = 0; i < blocks.length - 1; i++) {
      const last = blocks[i].steps.at(-1);
      if (last.pct < 95) continue;
      assert.ok(['Recovery', 'Flat road'].includes(blocks[i + 1].name), `${w.code}: ${blocks[i].name} ends at ${last.pct}% and runs into ${blocks[i + 1].name}`);
    }
  }
});

test('the last push builds on one resistance to a flat-out finish', () => {
  const { steps } = findBlock('Last push');
  assert.deepEqual(steps.map((s) => s.dur), [20, 20, 20]);
  assert.deepEqual(steps.map((s) => s.cadence), [85, 95, 105]);
  assert.ok(steps[1].hold && steps[2].hold && steps[2].kind === 'sprint');
  assert.ok(steps[0].pct < steps[1].pct && steps[1].pct < steps[2].pct);
});

test('gentle climbs keep turning, so a push is still a push under the resistance cap', () => {
  const easyPace = powerFor(DEFAULT_MODEL, 35, 80) / 0.7; // a rider whose easy pace is resistance 35 at 80 rpm
  for (let variant = 0; variant < 40; variant++) {
    const w = generateWorkout('spinlow', 60, variant);
    assert.ok(main(w).every((s) => s.cadence >= 75), w.code);
    const heavy = blocksOf(w).find((b) => b.name === 'Heavy pushes');
    if (!heavy) continue;
    const [climb, push] = heavy.steps.map((s) => stepTargets(s, w.segments, easyPace, DEFAULT_MODEL));
    assert.ok(push.resistance >= climb.resistance + 3, `${w.code}: climb ${climb.resistance}, push ${push.resistance}`);
  }
});

// The parts of the planner, each on its own.
const step = (dur, pct, kind = 'work', more = {}) => ({ dur, pct, kind, ...more });

test('a block is the same for the same seed, and joins on to the resistance before it', () => {
  const at = { budget: 2400 };
  assert.deepEqual(makeBlock('heavyPush', 7, at), makeBlock('heavyPush', 7, at));
  assert.notDeepEqual(makeBlock('heavyPush', 7, at).steps, makeBlock('heavyPush', 8, at).steps);
  // Joined to a lighter or a heavier block, only the efforts move: the shape stays.
  const light = makeBlock('resistancePush', 7, { ...at, load: 60 }), heavy = makeBlock('resistancePush', 7, { ...at, load: 90 });
  assert.deepEqual(light.steps.map((s) => s.dur), heavy.steps.map((s) => s.dur));
  assert.ok(light.steps[0].pct < heavy.steps[0].pct);
  // A longer class has longer steps and more rounds; a gentle block is seated.
  assert.ok(makeBlock('timeTrial', 3, { budget: 3600 }).steps[0].dur > makeBlock('timeTrial', 3, { budget: 900 }).steps[0].dur);
  assert.ok(makeBlock('jumps', 3, { budget: 3600 }).rounds >= makeBlock('jumps', 3, { budget: 900 }).rounds);
  const gentle = makeBlock('ladder', 3, { budget: 2400, low: true });
  assert.equal(gentle.title, 'Seated ladder');
  assert.ok(gentle.steps.every((s) => !s.stand && s.cadence >= 75 && s.resistanceCap === 50));
});

test('steps are measured for length, hard and standing time, and how hard they are', () => {
  const steps = [step(60, 100, 'work', { stand: true }), step(20, 150, 'sprint'), step(120, 55, 'recovery')];
  const m = measureSteps(steps);
  assert.equal(m.len, 200);
  assert.equal(m.stand, 60);
  assert.equal(m.allOut, 20);
  assert.equal(m.hard, 80);
  assert.equal(m.mean, (60 * 100 + 20 * 150 + 120 * 55) / 200);
  assert.ok(m.hardness > m.mean && m.hardness < 150);
  // A recovery the block ends on doesn't make it count as easier; rest in the middle of it does.
  assert.equal(measureSteps(steps.slice(0, 2)).hardness, m.hardness);
  assert.ok(measureSteps([steps[0], steps[2], steps[1]]).hardness < m.hardness);
});

test('a block is read for what it trains', () => {
  const kind = (id, low) => focusOf(makeBlock(id, 5, { budget: 2400, low }).steps, low);
  assert.equal(kind('sprints'), 'sprint');
  assert.equal(kind('lastPush'), 'sprint');
  for (const id of ['standing', 'jumps', 'ladder', 'switchbacks']) assert.equal(kind(id), 'standing', id);
  assert.equal(kind('tabata'), 'sprint'); // 20 seconds very hard, over and over
  for (const id of ['cadencePush', 'spinups']) assert.equal(kind(id), 'speed', id);
  for (const id of ['seated', 'attacks']) assert.equal(kind(id), 'climb', id);
  for (const id of ['resistancePush', 'creep', 'timeTrial']) assert.equal(kind(id), 'tempo', id);
  // Seated and eased, a ladder is no longer standing work and a sprint no longer a sprint.
  assert.notEqual(kind('ladder', true), 'standing');
  assert.equal(kind('sprints', true), 'speed');
});

test('hard riding tires the rider and easy riding clears it faster', () => {
  const work = [step(120, 92)], easy = [step(120, 55, 'recovery')];
  const tired = fatigueAfter(0, work);
  assert.ok(tired > 0);
  assert.equal(fatigueAfter(0, easy), 0); // no fresher than fresh
  assert.ok(fatigueAfter(tired, easy) < tired / 2);
  assert.ok(fatigueAfter(tired, work) > tired);
});

test('a rest is sized by how tired the rider is, and never skipped after rounds or a hard finish', () => {
  const block = (steps, rounds) => ({ steps, rounds });
  const fresh = (b) => restFor(b, fatigueAfter(0, b.steps));
  assert.equal(fresh(block([step(180, 70, 'steady')])), 0);
  assert.ok(fresh(block([step(300, 95)])) > fresh(block([step(120, 85)])));
  assert.equal(fresh(block([step(20, 80), step(20, 96)])), 75); // short, but ends hard
  assert.equal(fresh(block([step(30, 74, 'steady'), step(30, 80)], 3)), 75); // rounds
  assert.equal(fresh(block([step(30, 150, 'sprint'), step(75, 55, 'recovery')], 3)), 0); // already rests itself
  assert.ok(fresh(block([step(600, 120)])) <= 150);
  // The same block earns a longer rest late in a class than early.
  const climb = block([step(150, 90)]);
  assert.ok(restFor(climb, fatigueAfter(4000, climb.steps)) > fresh(climb));
});

test('blocks are laid out in waves that build', () => {
  const order = (hs) => inWaves(hs.map((h) => ({ h })), (b) => b.h).map((b) => b.h);
  // Six blocks: two waves, each climbing, the second from higher up, ending on the hardest.
  assert.deepEqual(order([5, 1, 3, 6, 2, 4]), [1, 3, 5, 2, 4, 6]);
  // Eight: three waves, each starting higher than the one before, and the last (a short one) ending on the hardest.
  const long = order([5, 1, 8, 3, 7, 2, 6, 4]);
  assert.deepEqual([...long].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(long[0], 1);
  assert.equal(long.at(-1), 8);
  const starts = long.filter((h, i) => !i || h < long[i - 1]);
  assert.equal(starts.length, 3);
  assert.ok(starts[0] < starts[1] && starts[1] < starts[2], String(long));
  assert.deepEqual(order([2, 1]), [1, 2]);
});

test('a class of one kind of work after another counts as less varied', () => {
  const b = (focus, len = 300) => ({ focus, m: { len } });
  assert.equal(sameness([b('climb'), b('speed'), b('standing'), b('tempo')]), 0);
  assert.equal(sameness([b('climb'), b('climb'), b('speed'), b('tempo')]), 1);
  assert.ok(sameness([b('climb'), b('speed'), b('climb'), b('climb', 900)]) > 1); // and mostly climbing
});

test('left-over time lengthens steady steps a little and leaves the rest alone', () => {
  const fresh = () => [
    { steps: [step(180, 75, 'steady')] },
    { steps: [step(45, 72, 'steady'), step(30, 95)], fixed: true }, // rounds stay even
    { steps: [step(150, 95, 'work', { stand: true }), step(60, 55, 'recovery')] }, // no longer out of the saddle
  ];
  const lengths = (items) => items.map((it) => it.steps.map((s) => s.dur));
  const some = fresh();
  assert.equal(spreadLeftover(some, 50), 5); // whole quarter-minutes only
  assert.deepEqual(lengths(some), [[210], [45, 30], [150, 75]]);
  // No step grows by more than a quarter, so a lot of time has nowhere to go.
  const lots = fresh();
  assert.equal(spreadLeftover(lots, 600), 540);
  assert.deepEqual(lengths(lots), [[225], [45, 30], [150, 75]]);
  // Nor past the most it should last.
  const capped = fresh();
  capped[0].steps[0].most = 195;
  capped[2].steps[1].most = 60;
  assert.equal(spreadLeftover(capped, 600), 585);
  assert.deepEqual(lengths(capped), [[195], [45, 30], [150, 60]]);
});

test('classes mix their kinds of work', () => {
  let back = 0, pairs = 0;
  for (let variant = 0; variant < 60; variant++) {
    const blocks = blocksOf(generateWorkout('spinclass', 60, variant)).filter((b) => !['Recovery', 'Flat road'].includes(b.name));
    const kinds = blocks.map((b) => focusOf(b.steps.map((s) => ({ ...s, stand: s.position === 'standing' }))));
    for (let i = 1; i < kinds.length; i++) { pairs++; if (kinds[i] === kinds[i - 1]) back++; }
    assert.ok(new Set(kinds).size >= 3, `${variant}: only ${[...new Set(kinds)]}`);
  }
  assert.ok(back / pairs < 0.15, `${back} of ${pairs} blocks train the same thing as the one before`);
});

test('a Tabata counts as flat out, so it is kept apart from sprints', () => {
  for (const minutes of [45, 60]) {
    for (let variant = 0; variant < 60; variant++) {
      const w = generateWorkout('spinclass', minutes, variant);
      const names = blocksOf(w).map((b) => b.name).filter((n) => !['Recovery', 'Flat road'].includes(n));
      const flatOut = (n) => ['Sprints', 'Tabata', 'Last push'].includes(n);
      for (let i = 1; i < names.length - 1; i++) assert.ok(!(flatOut(names[i]) && flatOut(names[i - 1])), `${w.code}: ${names[i - 1]} then ${names[i]}`);
    }
  }
});

test('a short class opens briefly, and a long one takes longer over it', () => {
  const opener = (minutes) => {
    const all = [];
    for (let variant = 0; variant < 30; variant++) all.push(blocksOf(generateWorkout('spinclass', minutes, variant))[0].steps[0].dur);
    return all.reduce((a, b) => a + b, 0) / all.length;
  };
  assert.ok(opener(22) <= 135, `${opener(22)}`);
  assert.ok(opener(60) > opener(22) + 30);
});

test('a held step in any ride is planned at the effort it really takes', () => {
  // A HIIT rest keeps the rep's resistance and only slows the legs, so it is not as easy as it was written.
  const w = generateWorkout('hiit', 22, 0);
  const rest = w.segments.find((s) => s.hold && s.label === 'Rest');
  const rep = w.segments[w.segments.indexOf(rest) - 1];
  assert.ok(rest.pct > 50 && rest.pct < rep.pct, `rep ${rep.pct}%, rest ${rest.pct}%`);
  const bike = { ...DEFAULT_MODEL, b: 1.6 };
  const real = (stepTargets(rest, w.segments, 300, bike).watts / 300) * 100;
  assert.ok(Math.abs(real - rest.pct) <= 6, `planned ${rest.pct}%, really ${real.toFixed(0)}%`);
});

test('asking for the same ride again gives the very same workout', () => {
  assert.equal(generateWorkout('spinclass', 45, 3), generateWorkout('spinclass', 45, 3));
  assert.notEqual(generateWorkout('spinclass', 45, 3), generateWorkout('spinclass', 45, 4));
  assert.notEqual(generateWorkout('spinclass', 45, 3), generateWorkout('spinclass', 45, 3, { exclude: ['tabata'] }));
});
