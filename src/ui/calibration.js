// The calibration dialog: ride a few steps so the app can learn the bike.

import { fitModel, crossValidate, resistanceFor, CALIBRATION_STEPS } from '../core/resistance.js';
import { addToBins, fitBins } from '../core/learn.js';
import { storage, saveCalibration, activeModel, setSimModel, learner, state } from './store.js';
import { $, toast } from './dom.js';
import { round1 } from './format.js';
import { renderSetup } from './setup.js';
import { isCalibratedBike } from './learning.js';
import { setSimMode } from './ride-view.js';

const STEPS = CALIBRATION_STEPS;
const SETTLE_S = 5;
const RECORD_S = 10;
const CADENCE_TOL = 8; // rpm either side of the step's cadence that counts as on target
const MIN_READINGS = 5;
const STALE_MS = 2000; // no packet for this long means the rider has stopped

export const calib = {
  open: false,
  phase: 'intro',
  level: 0,
  started: null, // when the rider first reached the step's cadence
  recordedS: 0,
  lastTick: 0,
  lastReading: 0,
  samples: [],
  levelSamples: [],
  model: null,
  check: null,
  timer: null,

  start() {
    if (state.bikeState !== 'connected') {
      toast('Connect a bike first.');
      return;
    }
    this.open = true;
    this.phase = 'intro';
    this.samples = [];
    this.model = null;
    this.check = null;
    this.render();
    $('calib').showModal();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
  },

  close() {
    this.open = false;
    clearInterval(this.timer);
    if (state.bikeKind === 'sim') setSimMode('auto');
    $('calib').close();
  },

  beginLevel(i) {
    this.phase = 'level';
    this.level = i;
    this.started = null;
    this.recordedS = 0;
    this.lastTick = performance.now();
    this.levelSamples = [];
    if (state.bikeKind === 'sim') {
      // Stand-in for the rider setting resistance and cadence.
      setSimMode('manual');
      state.bike.manualResistance = STEPS[i].resistance;
      state.bike.manualCadence = STEPS[i].cadence;
    }
    this.render();
  },

  // Pedalling at the step's cadence, going by the latest packets from the bike.
  onTarget() {
    const l = state.latest;
    return performance.now() - this.lastReading < STALE_MS
      && l.powerW > 0
      && Math.abs((l.cadence ?? 0) - STEPS[this.level].cadence) <= CADENCE_TOL;
  },

  settled() {
    return this.started !== null && (performance.now() - this.started) / 1000 >= SETTLE_S;
  },

  onReading() {
    if (!this.open || this.phase !== 'level') return;
    this.lastReading = performance.now();
    // A bike may split one reading over several packets, so read the merged latest.
    if (this.settled() && this.onTarget()) {
      // Trust the bike's own resistance reading when it agrees with the step, in
      // case the resistance is a level out; ignore it if it's on some other scale.
      const asked = STEPS[this.level].resistance;
      const reported = state.latest.resistance;
      const resistance = Math.abs(reported - asked) <= 5 ? reported : asked;
      this.levelSamples.push({ resistance, cadence: state.latest.cadence, power: state.latest.powerW });
    }
  },

  tick() {
    if (!this.open) return;
    if (this.phase === 'level') {
      const now = performance.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      // The step's clock only starts once the rider is up to cadence, and the
      // recording only counts time spent there, so every level gets its full share.
      if (this.started === null) {
        if (this.onTarget()) this.started = now;
      } else if (this.settled() && this.onTarget()) {
        this.recordedS += dt;
      }
      if (this.recordedS >= RECORD_S && this.levelSamples.length >= MIN_READINGS) {
        this.samples.push(...this.levelSamples);
        this.nextLevel();
        return;
      }
    }
    this.renderLive();
  },

  nextLevel() {
    if (this.level + 1 < STEPS.length) this.beginLevel(this.level + 1);
    else this.finish();
  },

  finish() {
    this.phase = 'result';
    this.model = fitModel(this.samples, activeModel());
    this.check = this.model ? crossValidate(this.samples, activeModel()) : null;
    if (state.bikeKind === 'sim') setSimMode('auto');
    this.render();
  },

  render() {
    const body = $('calib-body');
    const next = $('calib-next');
    const skip = $('calib-skip');
    skip.hidden = this.phase !== 'level';
    next.hidden = false;
    if (this.phase === 'intro') {
      body.innerHTML = `
        <p>You'll ride ${STEPS.length} short steps. Each one gives you a resistance and a cadence.</p>
        <p>Set the resistance by the number on the bike's screen, then pedal up to the cadence. Recording starts when you get there and takes ${RECORD_S} seconds. If you drift off the cadence, it pauses until you're back.</p>
        <p class="muted">About two and a half minutes of pedalling in total. Two of the resistances come up twice, once slow and once fast.</p>`;
      next.textContent = 'Begin';
    } else if (this.phase === 'level') {
      const st = STEPS[this.level];
      body.innerHTML = `
        <p class="muted small">Step ${this.level + 1} of ${STEPS.length}</p>
        <div class="calib-ask">
          <div><span class="calib-ask-lbl">Resistance</span><span class="big-number">${st.resistance}</span></div>
          <div><span class="calib-ask-lbl">Cadence</span><span class="big-number">${st.cadence}<small> rpm</small></span></div>
        </div>
        <p id="calib-phase" class="muted">Waiting for you to reach the cadence</p>
        <div class="calib-progress"><i id="calib-bar"></i></div>
        <div class="calib-live">
          <div id="cl-c-box" class="stat"><span id="cl-c" class="stat-num">0</span><span class="stat-label">Cadence now</span></div>
          <div class="stat"><span id="cl-r" class="stat-num">–</span><span class="stat-label">Resistance now</span></div>
          <div class="stat"><span id="cl-p" class="stat-num">0 W</span><span class="stat-label">Power</span></div>
        </div>`;
      next.hidden = true;
    } else {
      if (!this.model) {
        body.innerHTML = `<p class="error">Not enough readings to work with. Try again, and stay on each cadence until the step finishes.</p>`;
        next.textContent = 'Try again';
        return;
      }
      const cv = this.check;
      const rows = (cv?.results ?? []).map((x) => `<tr><td>Resistance ${x.level}</td><td>${Math.round(x.cadence)} rpm</td><td>${round1(x.predicted)}</td></tr>`).join('');
      const shaky = cv && cv.interiorMaxAbs > 2;
      body.innerHTML = `
        ${cv
          ? `<p>Done. Resistance targets should now be within about <b>±${round1(Math.max(0.5, cv.interiorMeanAbs))} levels</b> of the bike's screen. The worst step was out by ${round1(cv.maxAbs)}.</p>`
          : '<p>Done.</p>'}
        ${shaky ? '<p class="error small">A few steps were uneven. Run it again and hold each cadence steadier for a tighter result.</p>' : ''}
        <p class="muted small">Each step was left out in turn and predicted from the others:</p>
        <table class="calib-table"><thead><tr><th>Step</th><th>Cadence</th><th>Predicted</th></tr></thead><tbody>${rows}</tbody></table>
        <p>To check it, set any resistance and pedal. The app makes it <b id="calib-detect">—</b>.</p>`;
      next.textContent = 'Save';
    }
  },

  renderLive() {
    const l = state.latest;
    if (this.phase === 'level') {
      const bar = $('calib-bar');
      if (!bar) return;
      const want = STEPS[this.level].cadence;
      const cad = Math.round(l.cadence ?? 0);
      const off = cad - want;
      const settleS = this.started === null ? 0 : Math.min(SETTLE_S, (performance.now() - this.started) / 1000);
      bar.style.width = `${Math.min(100, ((settleS + this.recordedS) / (SETTLE_S + RECORD_S)) * 100)}%`;
      const left = Math.max(1, Math.ceil(RECORD_S - this.recordedS));
      $('calib-phase').textContent = this.started === null
        ? 'Waiting for you to reach the cadence'
        : !this.settled() ? 'Hold it there…'
          : this.onTarget() ? `Recording · ${left}s left` : `Paused · pedal ${off < 0 ? 'faster' : 'slower'}`;
      $('cl-r').textContent = l.resistance === undefined ? '–' : String(Math.round(l.resistance));
      $('cl-c').textContent = String(cad);
      $('cl-c-box').className = `stat ${cad > 0 ? (Math.abs(off) <= CADENCE_TOL ? 'good' : 'off') : ''}`;
      $('cl-p').textContent = `${Math.round(l.powerW ?? 0)} W`;
    } else if (this.phase === 'result' && this.model) {
      const el = $('calib-detect');
      if (el && l.powerW > 5 && l.cadence > 20) el.textContent = String(Math.round(resistanceFor(this.model, l.powerW, l.cadence)));
    }
  },
};

$('btn-calibrate-nudge').addEventListener('click', () => calib.start());
$('calib-cancel').addEventListener('click', () => calib.close());
$('calib-skip').addEventListener('click', () => calib.nextLevel());
$('calib').addEventListener('cancel', () => calib.close());
$('calib-next').addEventListener('click', async () => {
  if (calib.phase === 'intro') calib.beginLevel(0);
  else if (calib.phase === 'result') {
    if (calib.model) {
      // The simulator's formula is made up, so only a real bike's calibration is kept.
      if (state.bikeKind === 'ble') {
        // Recalibrating the same bike adds to what it has already learned.
        if (!isCalibratedBike()) learner.bins = {};
        for (const s of calib.samples) addToBins(learner.bins, s);
        const model = fitBins(learner.bins, activeModel()) ?? calib.model;
        const now = new Date().toISOString();
        const filed = saveCalibration({
          bike: state.bike.name,
          date: now,
          updated: now,
          model,
          check: calib.check,
          samples: calib.samples,
          bins: learner.bins,
        });
        toast(filed ? 'Calibration saved.' : "Calibration couldn't be saved: the browser's storage is full or blocked.");
      } else {
        setSimModel(calib.model);
        toast('Calibration saved.');
      }
      calib.close();
      renderSetup();
    } else {
      calib.samples = [];
      calib.beginLevel(0);
    }
  }
});

$('btn-calibrate-banner').addEventListener('click', () => calib.start());
$('calib-banner-later').addEventListener('click', () => {
  state.bannerDismissed = state.bike?.name;
  renderSetup();
});
