import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powerFor, resistanceFor, fitModel } from '../src/core/resistance.js';
import { Learner, addToBins, binsToSamples, fitBins, cadenceExponent, levelCounts, totalReadings } from '../src/core/learn.js';
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
  assert.equal(l.observe(reading(30, 81)), false); // steady, but only just
  assert.equal(l.observe(reading(30, 80)), true); // three in a row
  assert.equal(l.observe(reading(30, 81)), true);
  assert.equal(l.observe(reading(35, 81)), false); // resistance just moved
  assert.equal(l.observe(reading(35, 82)), false);
  assert.equal(l.observe(reading(35, 82)), true);
  assert.equal(l.observe(reading(35, 95)), false); // cadence jumped
  l.rest();
  assert.equal(l.observe(reading(35, 95)), false);
  assert.equal(l.added, 3);
});

test('a ride across many levels and cadences recovers the bike formula', () => {
  const l = new Learner();
  for (let r = 15; r <= 75; r += 3) {
    for (const cad of [68, 70, 84, 86, 98, 100]) {
      for (let k = 0; k < 8; k++) l.observe(reading(r, cad + (k % 2)));
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

test('the cadence exponent needs a level ridden at two cadences well apart', () => {
  const bins = {};
  // One level, cadence wandering over a few rpm: no evidence.
  for (let k = 0; k < 40; k++) addToBins(bins, reading(30, 84 + (k % 5)));
  assert.equal(cadenceExponent(bins), null);
  // The same level at 70 and 100 rpm: now there is.
  for (let k = 0; k < 10; k++) { addToBins(bins, reading(30, 70)); addToBins(bins, reading(30, 100)); }
  assert.ok(Math.abs(cadenceExponent(bins) - SIM_TRUE_MODEL.b) < 0.02);
});

test('a ride can only nudge the cadence exponent, however odd its readings', () => {
  const bins = {};
  for (const r of [20, 30, 40, 50, 60]) for (const cad of [70, 100]) for (let k = 0; k < 10; k++) addToBins(bins, reading(r, cad));
  const calibrated = fitBins(bins);
  // A ride whose watts lag the cadence, as a console's do: it would suggest a much steeper curve.
  for (const cad of [70, 100]) {
    for (let k = 0; k < 60; k++) addToBins(bins, { resistance: 35, cadence: cad, power: powerFor(SIM_TRUE_MODEL, 35, cad) * (cad > 85 ? 1.3 : 0.8) });
  }
  const free = fitBins(bins, calibrated);
  const careful = fitBins(bins, calibrated, { cautious: true });
  assert.ok(Math.abs(free.b - calibrated.b) > 0.05, 'the odd ride should pull an unguarded fit');
  assert.ok(Math.abs(careful.b - calibrated.b) <= 0.03 + 1e-9, `moved ${careful.b - calibrated.b}`);
});
