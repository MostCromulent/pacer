import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, powerFor, resistanceFor, fitModel, crossValidate, CALIBRATION_STEPS } from '../src/core/resistance.js';
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

test('calibration at one steady cadence still matches at that cadence', () => {
  const samples = samplesFrom(SIM_TRUE_MODEL, [84, 86, 88], 0.01);
  const m = fitModel(samples);
  assert.equal(m.kind, 'table');
  assert.ok(m.calibrated);
  for (const r of [25, 45, 65]) {
    const p = powerFor(SIM_TRUE_MODEL, r, 87);
    assert.ok(Math.abs(resistanceFor(m, p, 87) - r) < 1.5, `r=${r}`);
  }
});

test('the cadence exponent comes from cadence changes within a level', () => {
  const m = fitModel(samplesFrom(SIM_TRUE_MODEL, [65, 85, 105]));
  assert.ok(Math.abs(m.b - SIM_TRUE_MODEL.b) < 0.01, `b=${m.b}`);
});

test('table models round-trip and keep rising outside the measured levels', () => {
  const m = fitModel(samplesFrom(SIM_TRUE_MODEL, [70, 100]));
  for (const r of [5, 20, 33, 47, 80, 95]) {
    const p = powerFor(m, r, 88);
    assert.ok(Math.abs(resistanceFor(m, p, 88) - r) < 0.01, `r=${r}`);
  }
  for (let r = 1; r < 100; r += 3) assert.ok(powerFor(m, r + 3, 88) > powerFor(m, r, 88));
});

test('noisy readings that dip at one level are smoothed into a rising curve', () => {
  const samples = samplesFrom(SIM_TRUE_MODEL, [70, 100]).map((s) => (s.resistance === 50 ? { ...s, power: s.power * 0.8 } : s));
  const m = fitModel(samples);
  for (let i = 1; i < m.knots.length; i++) assert.ok(m.knots[i][1] > m.knots[i - 1][1]);
});

test('calibration refuses too little data', () => {
  assert.equal(fitModel([{ resistance: 40, cadence: 85, power: 120 }]), null);
  assert.equal(fitModel(samplesFrom(SIM_TRUE_MODEL, [85]).filter((s) => s.resistance < 40)), null);
});

// Stress test: the console's real formula is unknown, so calibrate against
// several plausible ones using the actual calibration ride (with a rider who
// drifts a few rpm and a noisy watts readout), then check every resistance
// target the workouts can ask for lands within the ±2 on-target band.
const BIKES = {
  'same shape as the model': (r, c) => powerFor(SIM_TRUE_MODEL, r, c),
  'watts proportional to cadence': (r, c) => c * (0.25 + 0.0006 * r * r),
  'watts proportional to cadence squared': (r, c) => c * c * (0.0045 + 6.3e-6 * r * r),
  'stepped lookup table': (r, c) => {
    const pts = [[0, 0.3], [20, 0.55], [40, 1.0], [55, 1.75], [70, 3.1], [85, 4.4], [100, 5.6]];
    let i = 0;
    while (i < pts.length - 2 && r > pts[i + 1][0]) i++;
    const [r0, f0] = pts[i];
    const [r1, f1] = pts[i + 1];
    return c * (f0 + ((f1 - f0) * (r - r0)) / (r1 - r0));
  },
};

function trueResistance(f, watts, cadence) {
  let lo = 1;
  let hi = 100;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid, cadence) < watts) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function calibrationRide(f, seed) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  return CALIBRATION_STEPS.flatMap(({ resistance, cadence }) => Array.from({ length: 10 }, () => {
    const c = cadence + (rnd() * 2 - 1) * 5;
    return { resistance, cadence: c, power: f(resistance, c) * (1 + (rnd() * 2 - 1) * 0.03) };
  }));
}

for (const [name, f] of Object.entries(BIKES)) {
  test(`stress: calibration handles a bike where ${name}`, () => {
    const samples = calibrationRide(f, 11);
    const m = fitModel(samples);
    const asks = [];
    for (const base of [160, 200, 260]) {
      for (const [pct, cad] of [[50, 85], [55, 92], [65, 88], [88, 85], [105, 80], [115, 95], [150, 105], [58, 70], [68, 110], [140, 100], [90, 65]]) {
        const watts = (pct / 100) * base;
        const want = trueResistance(f, watts, cad);
        if (want > 2 && want < 98) asks.push({ watts, cad, want });
      }
    }
    const errs = asks.map(({ watts, cad, want }) => Math.abs(resistanceFor(m, watts, cad) - want));
    assert.ok(Math.max(...errs) <= 2, `worst miss ${Math.max(...errs).toFixed(2)} levels`);
    // The held-out estimate shown to the rider errs on the cautious side.
    const cv = crossValidate(samples);
    assert.ok(cv.interiorMeanAbs >= errs.reduce((a, b) => a + b, 0) / errs.length - 0.2);
  });
}
