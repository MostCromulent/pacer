// The ride engine: integrates distance, tracks the workout, the ghost race and
// sprint gates. Pure logic, no DOM; driven by `update(dt, input)`.

import { stepSpeed } from './physics.js';
import { segmentIndexAt, zoneOf } from './workout.js';
import { resistanceFor, powerFor } from './resistance.js';
import { targetWatts } from './ghost.js';

const STALE_INPUT_S = 3;
const STEP_WARNING_S = 10;
export const SHORT_STEP_S = 25;
const CADENCE_TOLERANCE = 5;
const KNOB_TOLERANCE = 2;
export const DIFFICULTY_MIN = 0.5;
export const DIFFICULTY_MAX = 1.5;
export const DIFFICULTY_STEP = 0.05;

/**
 * What to aim for in a step: power, cadence, and the resistance that gives that
 * power at that cadence (from the resistance model), plus the on-target ranges.
 * Steps marked `hold` keep the previous step's resistance; their watts follow
 * from the lower cadence.
 */
export function stepTargets(seg, segments, baselineW, model) {
  const cadence = seg.cadence ?? 85;
  let watts = targetWatts(seg, baselineW);
  let knob = Math.round(resistanceFor(model, watts, cadence));
  if (seg.hold) {
    const prev = segments[segments.indexOf(seg) - 1];
    if (prev && !prev.hold) {
      knob = stepTargets(prev, segments, baselineW, model).knob;
      watts = powerFor(model, knob, cadence);
    }
  }
  const wattsTol = Math.max(10, watts * 0.06);
  const sprint = seg.kind === 'sprint';
  // The ranges that count as on target. Sprints have no upper limit.
  return {
    watts: Math.round(watts),
    cadence,
    knob,
    cadenceRange: [cadence - CADENCE_TOLERANCE, sprint ? null : cadence + CADENCE_TOLERANCE],
    knobRange: [Math.max(1, knob - KNOB_TOLERANCE), sprint ? null : Math.min(100, knob + KNOB_TOLERANCE)],
    wattsRange: sprint ? [Math.round(baselineW * 1.2), null] : [Math.round(watts - wattsTol), Math.round(watts + wattsTol)],
  };
}

/**
 * What to say out loud when a step begins: its name and the two numbers to aim
 * for. Short reps get a single word, since there's no time for more.
 * `targets` comes from stepTargets(); `mode` is 'knob' or 'watts'.
 */
export function spokenCue(seg, targets, mode = 'knob') {
  const said = seg.label.split('·').pop().replace(/[\d/]+|\bof\b/g, '').replace(/\s+/g, ' ').trim();
  const name = said.charAt(0).toUpperCase() + said.slice(1);
  if (seg.kind === 'sprint') return 'Sprint. All out.';
  if (seg.dur < SHORT_STEP_S) return seg.kind === 'work' ? 'Go.' : `${name}.`;
  if (seg.hold) return `${name}. Same resistance, cadence ${targets.cadence}.`;
  return mode === 'watts'
    ? `${name}. ${targets.watts} watts, cadence ${targets.cadence}.`
    : `${name}. Resistance ${targets.knob}, cadence ${targets.cadence}.`;
}

/** "80–90", or "105+" when there's no upper limit. */
export function formatRange([lo, hi]) {
  return hi === null ? `${lo}+` : `${lo}–${hi}`;
}

/** Power-based check, used when the knob position isn't known. */
export function isOnTarget(segment, baselineW, powerW, cadence) {
  if (segment.kind === 'sprint') return powerW >= baselineW * 1.2;
  if (segment.kind === 'drill' && segment.cadence) return Math.abs(cadence - segment.cadence) <= 5;
  const target = targetWatts(segment, baselineW);
  return Math.abs(powerW - target) <= Math.max(10, target * 0.06);
}

export class RideSession {
  /**
   * @param {object} o
   * @param {object} o.workout     from generateWorkout()
   * @param {number} o.baselineW
   * @param {object} o.model       resistance model
   * @param {import('./ghost.js').Ghost} o.ghost
   */
  constructor({ workout, baselineW, model, ghost }) {
    this.workout = workout;
    this.baselineW = baselineW;
    this.model = model;
    this.ghost = ghost;
    // Effort multiplier the rider can change mid-ride; scales every power target.
    this.difficulty = 1;
    this._difficultyS = 0;

    this.t = 0;
    this.dist = 0;
    this.speed = 0;
    this.input = { powerW: 0, cadence: 0, resistance: null, at: -Infinity };
    this.samples = { d: [0], p: [], c: [], r: [] };
    this.onTargetS = 0;
    this.segOnTarget = workout.segments.map(() => ({ on: 0, total: 0, powerSum: 0, cadSum: 0, knobSum: 0, knobT: 0 }));
    this.gateResults = [];
    this._activeGate = null;
    this._lastSeg = 0;
    this._warned = new Set();
    this._lastAhead = null;
    this._accum = { p: 0, c: 0, r: 0, n: 0 };
    this.done = false;
  }

  /** Feed the latest bike reading. Missing fields keep their previous values. */
  setInput({ powerW, cadence, resistance }) {
    if (powerW !== undefined) this.input.powerW = Math.max(0, powerW);
    if (cadence !== undefined) this.input.cadence = Math.max(0, cadence);
    if (resistance !== undefined && resistance !== null) this.input.resistance = resistance;
    this.input.at = this.t;
  }

  /**
   * Advance the ride by dt seconds. Returns events that happened during the step:
   * 'stepSoon' | 'stepChange' | 'gateStart' | 'gateEnd' | 'passedGhost' | 'ghostPassed' | 'done'
   */
  update(dt) {
    const events = [];
    if (this.done || dt <= 0) return events;
    dt = Math.min(dt, 1);

    const stale = this.t - this.input.at > STALE_INPUT_S;
    const powerW = stale ? 0 : this.input.powerW;
    const cadence = stale ? 0 : this.input.cadence;

    const prevT = this.t;
    this.t = Math.min(this.workout.totalS, this.t + dt);
    const realDt = this.t - prevT;

    this.speed = stepSpeed(this.speed, powerW, realDt);
    this.dist += this.speed * realDt;
    this._difficultyS += this.difficulty * realDt;

    const si = segmentIndexAt(this.workout, Math.max(0, this.t - 1e-6));
    const seg = this.workout.segments[si];
    const knob = stale ? null : this.currentResistance();
    const on = this.status(seg, powerW, cadence, knob).onTarget;
    if (on) this.onTargetS += realDt;
    const so = this.segOnTarget[si];
    so.total += realDt;
    so.powerSum += powerW * realDt;
    so.cadSum += cadence * realDt;
    if (knob !== null) { so.knobSum += knob * realDt; so.knobT += realDt; }
    if (on) so.on += realDt;

    // One sample per whole second, averaged over the second.
    this._accum.p += powerW * realDt;
    this._accum.c += cadence * realDt;
    this._accum.r += (this.currentResistance() ?? 0) * realDt;
    this._accum.n += realDt;
    while (this.samples.d.length - 1 < Math.floor(this.t + 1e-9)) {
      const n = this._accum.n || 1;
      this.samples.d.push(Math.round(this.dist * 10) / 10);
      this.samples.p.push(Math.round(this._accum.p / n));
      this.samples.c.push(Math.round(this._accum.c / n));
      this.samples.r.push(Math.round(this._accum.r / n));
      this._accum = { p: 0, c: 0, r: 0, n: 0 };
    }

    // Step changes and the heads-up before them.
    if (si !== this._lastSeg) {
      events.push('stepChange');
      this._lastSeg = si;
    }
    const next = this.workout.segments[si + 1];
    // No heads-up inside short HIIT reps: the change chime itself is the cue.
    if (next && seg.dur >= SHORT_STEP_S) {
      const left = seg.start + seg.dur - this.t;
      if (left <= STEP_WARNING_S && !this._warned.has(si)) {
        this._warned.add(si);
        events.push('stepSoon');
      }
    }

    // Sprint gates.
    const ghostD = this.ghost.distanceAt(this.t);
    if (this._activeGate) {
      const g = this._activeGate;
      if (this.t >= g.end) {
        const you = this.dist - g.youStart;
        const ghost = this.ghost.distanceAt(g.end) - g.ghostStart;
        this.gateResults.push({ index: g.index, you, ghost, won: you > ghost });
        this._activeGate = null;
        events.push('gateEnd');
      }
    }
    if (!this._activeGate) {
      const g = this.workout.gates.find((x) => this.t >= x.start && this.t < x.end && !this.gateResults.some((r) => r.index === x.index));
      if (g) {
        this._activeGate = { ...g, youStart: this.dist, ghostStart: this.ghost.distanceAt(g.start) };
        events.push('gateStart');
      }
    }

    // Overtakes, with a little hysteresis so we don't chime on every wobble.
    const gap = this.dist - ghostD;
    if (this._lastAhead === null && this.t > 5) this._lastAhead = gap >= 0;
    if (this._lastAhead === false && gap > 3) { this._lastAhead = true; events.push('passedGhost'); }
    if (this._lastAhead === true && gap < -3) { this._lastAhead = false; events.push('ghostPassed'); }

    if (this.t >= this.workout.totalS) {
      this.done = true;
      events.push('done');
    }
    return events;
  }

  currentResistance() {
    if (this.input.resistance !== null) return this.input.resistance;
    if (this.input.powerW > 5 && this.input.cadence > 20) {
      return resistanceFor(this.model, this.input.powerW, this.input.cadence);
    }
    return null;
  }

  /** Set the effort multiplier (0.5-1.5, in 5% steps). Returns the new value. */
  setDifficulty(value) {
    const snapped = Math.round(value / DIFFICULTY_STEP) * DIFFICULTY_STEP;
    this.difficulty = Math.round(Math.min(DIFFICULTY_MAX, Math.max(DIFFICULTY_MIN, snapped)) * 100) / 100;
    return this.difficulty;
  }

  /** Make the ride easier (-1) or harder (+1) by one step. */
  nudgeDifficulty(steps) {
    return this.setDifficulty(this.difficulty + steps * DIFFICULTY_STEP);
  }

  /** Baseline with the current effort applied: what targets are built from. */
  get effectiveBaselineW() {
    return this.baselineW * this.difficulty;
  }

  /**
   * What to aim for in a step: power, cadence, and the knob level that gives
   * that power at that cadence (from the resistance model).
   */
  targetsFor(seg) {
    return stepTargets(seg, this.workout.segments, this.effectiveBaselineW, this.model);
  }

  /**
   * How the rider is doing against the step's targets.
   * Each of cadence/knob is 'on' | 'low' | 'high' (knob is null when unknown).
   */
  status(seg, powerW, cadence, knob) {
    const tg = this.targetsFor(seg);
    const sprint = seg.kind === 'sprint';
    const judge = (have, want, tol) => {
      if (have === null) return null;
      if (sprint) return have >= want - tol ? 'on' : 'low';
      if (Math.abs(have - want) <= tol) return 'on';
      return have < want ? 'low' : 'high';
    };
    const cadenceStatus = judge(cadence, tg.cadence, CADENCE_TOLERANCE);
    const knobStatus = judge(knob === null ? null : Math.round(knob), tg.knob, KNOB_TOLERANCE);
    // On target if the power is right, or if cadence and knob both match the plan.
    const onTarget = isOnTarget(seg, this.effectiveBaselineW, powerW, cadence) || (cadenceStatus === 'on' && knobStatus === 'on');
    return { targets: tg, cadenceStatus, knobStatus, onTarget };
  }

  /** Everything the UI needs to draw a frame. */
  snapshot() {
    const w = this.workout;
    const si = segmentIndexAt(w, Math.max(0, this.t - 1e-6));
    const seg = w.segments[si];
    const stale = this.t - this.input.at > STALE_INPUT_S;
    const powerW = stale ? 0 : this.input.powerW;
    const cadence = stale ? 0 : this.input.cadence;
    const ghostDist = this.ghost.distanceAt(this.t);
    const resistance = stale ? null : this.currentResistance();

    const st = this.status(seg, powerW, cadence, resistance);
    const tg = st.targets;
    const res = formatRange(tg.knobRange);
    const rpm = `${formatRange(tg.cadenceRange)} rpm`;
    let cue;
    if (resistance === null) {
      cue = { type: 'up', text: `Set resistance to ${res}` };
    } else if (st.knobStatus === 'low') {
      cue = { type: 'up', text: `Resistance up to ${res}` };
    } else if (st.knobStatus === 'high') {
      cue = { type: 'down', text: `Resistance down to ${res}` };
    } else if (st.cadenceStatus === 'low') {
      cue = { type: 'up', text: `Pedal faster · ${rpm}` };
    } else if (st.cadenceStatus === 'high') {
      cue = { type: 'down', text: `Ease the cadence · ${rpm}` };
    } else {
      cue = { type: 'ok', text: 'Spot on, hold it' };
    }
    if (seg.kind === 'sprint') cue = { ...cue, type: 'gate', text: cue.type === 'ok' ? 'All out!' : cue.text };

    let gate = null;
    if (this._activeGate) {
      const g = this._activeGate;
      gate = {
        index: g.index,
        count: w.gates.length,
        left: g.end - this.t,
        you: this.dist - g.youStart,
        ghost: ghostDist - g.ghostStart,
      };
    }
    const upcoming = w.gates.find((g) => g.start > this.t);

    return {
      t: this.t,
      totalS: w.totalS,
      dist: this.dist,
      speed: this.speed,
      ghostDist,
      gap: this.dist - ghostDist,
      ghostLabel: this.ghost.label,
      ghostSpeed: this.ghost.speedAt(this.t),
      ghostCadence: this.ghost.cadenceAt(this.t) ?? 86,
      segIndex: si,
      seg,
      zone: zoneOf((tg.watts / this.effectiveBaselineW) * 100),
      stepLeft: seg.start + seg.dur - this.t,
      targetW: tg.watts,
      targetCadence: tg.cadence,
      targetKnob: tg.knob,
      cadenceRange: tg.cadenceRange,
      knobRange: tg.knobRange,
      wattsRange: tg.wattsRange,
      difficulty: this.difficulty,
      powerW: Math.round(powerW),
      cadence: Math.round(cadence),
      resistance: resistance === null ? null : Math.round(resistance),
      cadenceStatus: st.cadenceStatus,
      knobStatus: st.knobStatus,
      onTarget: st.onTarget,
      cue,
      gate,
      nextGate: upcoming ? { index: upcoming.index, count: w.gates.length, inS: upcoming.start - this.t } : null,
      noSignal: stale,
      done: this.done,
    };
  }

  /** Final numbers for the summary screen and for saving. */
  summary() {
    const w = this.workout;
    const secs = this.samples.p.length || 1;
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const gapPerMinute = [];
    for (let m = 1; m * 60 <= this.samples.d.length - 1; m++) {
      gapPerMinute.push(this.samples.d[m * 60] - this.ghost.distanceAt(m * 60));
    }
    const climbs = w.segments
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => (s.kind === 'work' || s.kind === 'sprint' || s.kind === 'drill') && this.segOnTarget[i].total > 0)
      .map(({ s, i }) => {
        const so = this.segOnTarget[i];
        const tg = this.targetsFor(s);
        return {
          label: s.label,
          avgW: so.total ? Math.round(so.powerSum / so.total) : 0,
          avgCadence: so.total ? Math.round(so.cadSum / so.total) : 0,
          avgKnob: so.knobT ? Math.round(so.knobSum / so.knobT) : null,
          targetCadence: tg.cadence,
          targetKnob: tg.knob,
          onTargetPct: so.total ? Math.round((so.on / so.total) * 100) : 0,
        };
      });
    return {
      distanceM: this.dist,
      durationS: this.t,
      avgPowerW: Math.round(avg(this.samples.p)),
      avgCadence: Math.round(avg(this.samples.c.filter((c) => c > 0))),
      onTargetS: this.onTargetS,
      onTargetPct: Math.round((this.onTargetS / Math.max(1, this.t)) * 100),
      avgDifficulty: this.t ? Math.round((this._difficultyS / this.t) * 100) / 100 : 1,
      ghostKind: this.ghost.kind,
      ghostFinal: this.ghost.distanceAt(this.t),
      gap: this.dist - this.ghost.distanceAt(this.t),
      gapPerMinute,
      gates: this.gateResults,
      climbs,
      seconds: secs,
    };
  }
}
