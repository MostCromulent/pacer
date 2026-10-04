import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, powerFor, resistanceFor, fitModel, modelError } from '../src/core/resistance.js';
import { SIM_TRUE_MODEL } from '../src/core/sim.js';

test('default model gives plausible spin-bike watts', () => {
  const p30 = powerFor(DEFAULT_MODEL, 30, 80);
  const p50 = powerFor(DEFAULT_MODEL, 50, 85);
  const p70 = powerFor(DEFAULT_MODEL, 70, 90);
  assert.ok(Math.abs(p30 - 70) < 3, `p30=${p30}`);
  assert.ok(Math.abs(p50 - 150) < 5, `p50=${p50}`);
  assert.ok(Math.abs(p70 - 300) < 10, `p70=${p70}`);
});

test('power rises with knob and cadence', () => {
  for (let r = 5; r < 100; r += 5) assert.ok(powerFor(DEFAULT_MODEL, r + 5, 85) > powerFor(DEFAULT_MODEL, r, 85));
  assert.ok(powerFor(DEFAULT_MODEL, 40, 95) > powerFor(DEFAULT_MODEL, 40, 80));
  assert.equal(powerFor(DEFAULT_MODEL, 40, 0), 0);
});

test('resistanceFor inverts powerFor across the knob range', () => {
  for (const cad of [70, 85, 100]) {
    for (let r = 5; r <= 95; r += 10) {
      const p = powerFor(DEFAULT_MODEL, r, cad);
      assert.ok(Math.abs(resistanceFor(DEFAULT_MODEL, p, cad) - r) < 0.01, `r=${r} cad=${cad}`);
    }
  }
});

test('resistanceFor clamps impossible targets', () => {
  assert.equal(resistanceFor(DEFAULT_MODEL, 5000, 80), 100);
  assert.equal(resistanceFor(DEFAULT_MODEL, 1, 80), 1);
  assert.equal(resistanceFor(DEFAULT_MODEL, 0, 80), 1);
});

function samplesFrom(model, cadences, noise = 0) {
  const out = [];
  let k = 1;
  for (const r of [20, 30, 40, 50, 60, 70, 80]) {
    for (const cad of cadences) {
      const wobble = noise ? 1 + noise * Math.sin(k++ * 12.9898) : 1;
      out.push({ resistance: r, cadence: cad, power: powerFor(model, r, cad) * wobble });
    }
  }
  return out;
}

test('calibration recovers the simulated bike from steady-cadence samples', () => {
  const samples = samplesFrom(SIM_TRUE_MODEL, [84, 86, 88], 0.01);
  const m = fitModel(samples);
  assert.ok(m.calibrated);
  assert.ok(modelError(m, samples) < 4, `rmse=${modelError(m, samples)}`);
  for (const r of [25, 45, 65]) {
    const p = powerFor(SIM_TRUE_MODEL, r, 87);
    assert.ok(Math.abs(resistanceFor(m, p, 87) - r) < 1.5, `r=${r}`);
  }
});

test('calibration fits the cadence exponent when cadence varies', () => {
  const samples = samplesFrom(SIM_TRUE_MODEL, [65, 85, 105]);
  const m = fitModel(samples);
  assert.ok(Math.abs(m.b - SIM_TRUE_MODEL.b) < 0.01, `b=${m.b}`);
});

test('calibration refuses too little data', () => {
  assert.equal(fitModel([{ resistance: 40, cadence: 85, power: 120 }]), null);
  assert.equal(fitModel(samplesFrom(SIM_TRUE_MODEL, [85]).filter((s) => s.resistance < 40)), null);
});
