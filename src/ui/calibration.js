// The calibration dialog: ride a few steps so the app can learn the bike.

import { fitModel, crossValidate, resistanceFor, CALIBRATION_STEPS } from '../core/resistance.js';
import { addToBins, fitBins } from '../core/learn.js';
import { storage, saveCalibration, activeModel, setSimModel, learner, state } from './store.js';
import { $, toast } from './dom.js';
import { round1 } from './format.js';
import { renderSetup } from './setup.js';
import { isCalibratedBike } from './learning.js';
import { askForPace } from './pace.js';
import { setSimMode } from './ride-view.js';

const STEPS = CALIBRATION_STEPS;
const SETTLE_S = 5;
const RECORD_S = 10;
const RESISTANCE_TOL = 1; // levels either side of the step's resistance, when the bike reports it
const RING = 2 * Math.PI * 26; // circumference of the recording ring
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
    if (state.bikeState !== 'connected' || state.bikeKind === 'basic') {
      toast(state.bikeKind === 'basic' ? 'Calibrating needs a smart bike: connect one first.' : 'Connect a bike first.');
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

  /** How the cadence and resistance compare with what the step asks: 'on' | 'low' | 'high' | ''. */
  status() {
    const l = state.latest;
    const step = STEPS[this.level];
    const judge = (have, want, tol) => (Math.abs(have - want) <= tol ? 'on' : have < want ? 'low' : 'high');
    const cadence = l.cadence > 0 ? judge(l.cadence, step.cadence, CADENCE_TOL) : '';
    // A bike that reports its resistance lets us check the level is set right.
    const resistance = l.resistance === undefined ? '' : judge(Math.round(l.resistance), step.resistance, RESISTANCE_TOL);
    return { cadence, resistance };
  },

  // Pedalling at the step's cadence (and resistance, where it can be checked),
  // going by the latest packets from the bike.
  onTarget() {
    const { cadence, resistance } = this.status();
    return performance.now() - this.lastReading < STALE_MS
      && state.latest.powerW > 0
      && cadence === 'on'
      && (resistance === 'on' || resistance === '');
  },

  settled() {
    return this.started !== null && (performance.now() - this.started) / 1000 >= SETTLE_S;
  },

  onReading() {
    if (!this.open || this.phase !== 'level') return;
    this.lastReading = performance.now();
    // A bike may split one reading over several packets, so read the merged latest.
    if (this.settled() && this.onTarget()) {
      // The bike's own resistance reading is the truth where there is one.
      const resistance = state.latest.resistance ?? STEPS[this.level].resistance;
      this.levelSamples.push({ resistance, cadence: state.latest.cadence, power: state.latest.powerW });
    }
  },

  tick() {
    if (!this.open) return;
    if (this.phase === 'level') {
      const now = performance.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      // The step's clock only starts once the rider is on target, and the
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
        <p>Set the resistance by the number on the bike's screen, then pedal up to the cadence. The tiles turn green when you're there; recording then takes ${RECORD_S} seconds, and pauses if you drift off.</p>
        <p class="muted">About two and a half minutes of pedalling in total. Two of the resistances come up twice, once slow and once fast.</p>
        <p>You only need to do this once. If your bike sends its resistance (the Schwinn 800IC does), Pacer then keeps learning as you ride, and the calibration gets better with every ride.</p>`;
      next.textContent = 'Begin';
    } else if (this.phase === 'level') {
      const st = STEPS[this.level];
      const reports = state.latest.resistance !== undefined;
      body.innerHTML = `
        <div class="calib-dots" role="img" aria-label="Step ${this.level + 1} of ${STEPS.length}">${STEPS.map((_, i) => `<i class="${i < this.level ? 'done' : i === this.level ? 'now' : ''}"></i>`).join('')}</div>
        <div class="num-cols">
          <div id="ct-c" class="num-col">
            <span class="num-lbl">Cadence</span>
            <span class="num-big"><span id="ct-c-now">0</span><span id="ct-c-arrow" class="num-arrow" aria-hidden="true"></span></span>
            <span class="num-aim">aim <b>${st.cadence}</b></span>
          </div>
          <div id="ct-r" class="num-col">
            <span class="num-lbl">Resistance</span>
            <span class="num-big"><span id="ct-r-now">${reports ? '–' : st.resistance}</span><span id="ct-r-arrow" class="num-arrow" aria-hidden="true"></span></span>
            <span class="num-aim">${reports ? `set to <b>${st.resistance}</b>` : "on the bike's screen"}</span>
          </div>
        </div>
        <div class="calib-ring">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="26" fill="none" stroke="var(--track)" stroke-width="8"/>
            <circle id="calib-ring" cx="32" cy="32" r="26" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${RING}" transform="rotate(-90 32 32)"/>
            <text id="calib-count" x="32" y="38" text-anchor="middle">${RECORD_S}</text>
          </svg>
          <span><b id="calib-phase"></b><span id="calib-sub"></span></span>
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
        <p>To check it, set any resistance and pedal. The app makes it <b id="calib-detect">—</b>.</p>
        <p class="nudge good small">${state.latest.resistance !== undefined
          ? 'From now on Pacer learns as you ride, so this gets better with every ride.'
          : "This bike doesn't send its resistance, so Pacer can't learn from your rides. Calibrate again if the numbers stop matching the bike's screen."}</p>`;
      next.textContent = 'Save';
    }
  },

  renderLive() {
    const l = state.latest;
    if (this.phase === 'level') {
      const ring = $('calib-ring');
      if (!ring) return;
      const step = STEPS[this.level];
      const { cadence, resistance } = this.status();
      const reports = l.resistance !== undefined;
      const arrow = { low: '↑', high: '↓' };

      $('ct-c-now').textContent = String(Math.round(l.cadence ?? 0));
      $('ct-c-arrow').textContent = arrow[cadence] ?? '';
      $('ct-c').className = `num-col ${cadence}`;
      if (reports) {
        $('ct-r-now').textContent = String(Math.round(l.resistance));
        $('ct-r-arrow').textContent = arrow[resistance] ?? '';
        $('ct-r').className = `num-col ${resistance}`;
      }

      // What to put right first: the resistance, then the cadence.
      const fix = resistance === 'low' || resistance === 'high'
        ? `Turn the resistance ${resistance === 'low' ? 'up' : 'down'} to ${step.resistance}`
        : cadence === 'on' ? '' : `Pedal ${cadence === 'high' ? 'slower' : 'faster'}, to ${step.cadence} rpm`;
      const recording = this.settled() && this.onTarget();
      const left = Math.max(1, Math.ceil(RECORD_S - this.recordedS));
      let phase;
      let sub;
      if (this.started === null) {
        phase = fix || 'Hold it there…';
        sub = reports ? 'Recording starts when both tiles are green.' : 'Recording starts when the cadence tile is green.';
      } else if (!this.settled()) {
        phase = 'Hold it there…';
        sub = 'Recording in a moment.';
      } else if (recording) {
        phase = 'Recording · hold it there';
        sub = `${left} second${left === 1 ? '' : 's'} left on this step.`;
      } else {
        phase = 'Paused';
        sub = fix ? `${fix}.` : 'Keep pedalling.';
      }
      $('calib-phase').textContent = phase;
      $('calib-sub').textContent = sub;
      ring.setAttribute('stroke-dasharray', `${Math.min(1, this.recordedS / RECORD_S) * RING} ${RING}`);
      ring.setAttribute('stroke', recording ? 'var(--sage)' : 'var(--mustard)');
      $('calib-count').textContent = String(this.recordedS > 0 ? left : RECORD_S);
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
      askForPace();
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
