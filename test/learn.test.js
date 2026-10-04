import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powerFor, resistanceFor, fitModel } from '../src/core/resistance.js';
import { Learner, addToBins, binsToSamples, fitBins, levelCounts, totalReadings } from '../src/core/learn.js';
import { SIM_TRUE_MODEL } from '../src/core/sim.js';

const reading = (resistance, cadence) => ({ resistance, cadence, power: powerFor(SIM_TRUE_MODEL, resistance, cadence) });

test('bins pool readings by level and cadence', () => {
  const bins = {};
  for (let i = 0; i < 6; i++) addToBins(bins, reading(40, 84 + (i % 3)));
  addToBins(bins, reading(40, 100));
  assert.deepEqual(levelCounts(bins), { 40: 7 });
  assert.equal(totalReadings(bins), 7);
  const samples = binsToSamples(bins);
  assert.equal(samples.length, 2);
  assert.equal(samples.reduce((n, s) => n + s.weight, 0), 7);
});

test('unusable readings and barely ridden levels are left out', () => {
  const bins = {};
  assert.equal(addToBins(bins, { resistance: 40, cadence: 0, power: 0 }), false);
  assert.equal(addToBins(bins, { resistance: 0, cadence: 80, power: 100 }), false);
  for (let i = 0; i < 3; i++) addToBins(bins, reading(55, 80));
  assert.equal(binsToSamples(bins).length, 0);
});

test('the learner skips readings taken while resistance or cadence is changing', () => {
  const l = new Learner();
  assert.equal(l.observe(reading(30, 80)), false); // nothing to compare with yet
  assert.equal(l.observe(reading(30, 81)), true);
  assert.equal(l.observe(reading(35, 81)), false); // resistance just moved
  assert.equal(l.observe(reading(35, 82)), true);
  assert.equal(l.observe(reading(35, 95)), false); // cadence jumped
  l.rest();
  assert.equal(l.observe(reading(35, 95)), false);
  assert.equal(l.added, 2);
});

test('a ride across many levels and cadences recovers the bike formula', () => {
  const l = new Learner();
  for (let r = 15; r <= 75; r += 3) {
    for (const cad of [68, 70, 84, 86, 98, 100]) {
      for (let k = 0; k < 4; k++) l.observe(reading(r, cad + (k % 2)));
    }
  }
  const m = fitBins(l.bins);
  assert.ok(m?.calibrated);
  for (const [r, cad] of [[20, 90], [41, 75], [58, 85], [70, 70]]) {
    const got = resistanceFor(m, powerFor(SIM_TRUE_MODEL, r, cad), cad);
    assert.ok(Math.abs(got - r) < 1.5, `r=${r} cad=${cad} got=${got}`);
  }
});

test('weighted samples fit the same as the readings they stand for', () => {
  const raw = [];
  const bins = {};
  for (const r of [20, 30, 40, 50, 60]) {
    for (const cad of [70, 100]) {
      for (let k = 0; k < 6; k++) {
        raw.push(reading(r, cad));
        addToBins(bins, reading(r, cad));
      }
    }
  }
  const a = fitModel(raw);
  const b = fitBins(bins);
  assert.ok(Math.abs(a.b - b.b) < 1e-9);
  assert.ok(Math.abs(powerFor(a, 45, 85) - powerFor(b, 45, 85)) < 1e-6);
});
