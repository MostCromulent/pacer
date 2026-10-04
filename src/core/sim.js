// A simulated spin bike, so the app can be built and tried without the real one.
// It behaves like the console: it computes watts from cadence and knob position
// with its own (hidden) formula and reports roughly once a second.

import { powerFor } from './resistance.js';

// Deliberately a little different from the app's default model, so calibration
// has something real to learn.
export const SIM_TRUE_MODEL = Object.freeze({ a: -2.52, b: 1.28, c: 0.0402, d: -7.9e-5, calibrated: true });

export class SimulatedBike extends EventTarget {
  constructor({ reportResistance = false, seed = 7 } = {}) {
    super();
    this.model = SIM_TRUE_MODEL;
    this.reportResistance = reportResistance;
    this.mode = 'auto';
    this.cadence = 0;
    this.resistance = 30;
    this.manualCadence = 85;
    this.manualResistance = 35;
    this.skill = 1;
    this.running = false;
    this._lastEmit = null;
    this._rand = mulberry32(seed);
    this.targetProvider = null;
  }

  start() {
    this.running = true;
    this._lastEmit = null;
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'connected', name: 'Simulated bike' } }));
  }

  stop() {
    this.running = false;
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'disconnected', name: 'Simulated bike' } }));
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'manual') {
      this.manualCadence = Math.round(this.cadence || 85);
      this.manualResistance = Math.round(this.resistance);
    }
  }

  nudgeCadence(delta) {
    this.setMode('manual');
    this.manualCadence = clamp(this.manualCadence + delta, 0, 140);
  }

  nudgeKnob(delta) {
    this.setMode('manual');
    this.manualResistance = clamp(this.manualResistance + delta, 1, 100);
  }

  /** Call often (e.g. every animation frame); emits a reading about once a second. */
  tick(nowS) {
    if (!this.running) return;
    if (this._lastEmit === null) this._lastEmit = nowS - 1;
    const dt = nowS - this._lastEmit;
    if (dt < 1) return;
    this._lastEmit = nowS;
    this._step(Math.min(dt, 3));
  }

  _step(dt) {
    const noise = () => this._rand() * 2 - 1;
    let wantCad;
    let wantR;
    if (this.mode === 'manual') {
      wantCad = this.manualCadence;
      wantR = this.manualResistance;
    } else {
      const t = this.targetProvider?.() ?? null;
      this.skill = clamp(this.skill + noise() * 0.015, 0.93, 1.07);
      if (!t) {
        wantCad = 78;
        wantR = 28;
      } else {
        // Do what the screen says: spin the target cadence, set the target knob.
        // With an uncalibrated model the watts come out a bit off, as they would
        // on a real bike.
        wantCad = t.seg.kind === 'sprint' ? Math.max(t.targetCadence, 108) : t.targetCadence;
        wantR = t.targetKnob + (this.skill - 1) * 20;
      }
      wantCad += noise() * 2;
    }
    // A person doesn't snap to a new cadence or knob position instantly.
    this.cadence += clamp(wantCad - this.cadence, -8 * dt, 8 * dt);
    this.resistance += clamp(wantR - this.resistance, -4 * dt, 4 * dt);
    const cadence = Math.max(0, this.cadence);
    const power = cadence > 5 ? powerFor(this.model, this.resistance, cadence) * (1 + noise() * 0.02) : 0;

    const reading = {
      powerW: Math.round(power),
      cadence: Math.round(cadence * 2) / 2,
      speedKmh: Math.round(cadence * 0.36 * 100) / 100,
    };
    if (this.reportResistance) reading.resistance = Math.round(this.resistance);
    this.dispatchEvent(new CustomEvent('data', { detail: reading }));
  }
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
