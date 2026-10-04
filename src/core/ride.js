// The ride engine: integrates distance, tracks the workout, the ghost race and
// sprint gates. Pure logic, no DOM; driven by `update(dt, input)`.

import { stepSpeed } from './physics.js';
import { segmentIndexAt, zoneOf } from './workout.js';
import { resistanceFor } from './resistance.js';
import { targetWatts } from './ghost.js';

const STALE_INPUT_S = 3;
const STEP_WARNING_S = 10;
const CADENCE_WINDOW_S = 30;

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
   * @param {number} [o.defaultCadence]
   */
  constructor({ workout, baselineW, model, ghost, defaultCadence = 85 }) {
    this.workout = workout;
    this.baselineW = baselineW;
    this.model = model;
    this.ghost = ghost;
    this.defaultCadence = defaultCadence;

    this.t = 0;
    this.dist = 0;
    this.speed = 0;
    this.input = { powerW: 0, cadence: 0, resistance: null, at: -Infinity };
    this.samples = { d: [0], p: [], c: [], r: [] };
    this.onTargetS = 0;
    this.segOnTarget = workout.segments.map(() => ({ on: 0, total: 0, powerSum: 0 }));
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

    const si = segmentIndexAt(this.workout, Math.max(0, this.t - 1e-6));
    const seg = this.workout.segments[si];
    const on = isOnTarget(seg, this.baselineW, powerW, cadence);
    if (on) this.onTargetS += realDt;
    const so = this.segOnTarget[si];
    so.total += realDt;
    so.powerSum += powerW * realDt;
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
    if (next) {
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

  /** The rider's usual cadence lately, used to turn target watts into a knob level. */
  preferredCadence() {
    const c = this.samples.c.slice(-CADENCE_WINDOW_S).filter((x) => x > 40);
    if (c.length < 5) return this.defaultCadence;
    const sorted = [...c].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
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

    let cue;
    if (seg.kind === 'sprint') {
      cue = { type: 'gate', text: 'All out!' };
    } else if (seg.kind === 'drill' && seg.cadence) {
      const diff = seg.cadence - cadence;
      cue = Math.abs(diff) <= 5
        ? { type: 'ok', text: `${seg.cadence} rpm · spot on` }
        : { type: diff > 0 ? 'up' : 'down', text: `Spin ${diff > 0 ? 'faster' : 'slower'} · ${seg.cadence} rpm` };
    } else {
      const target = targetWatts(seg, this.baselineW);
      const wantR = Math.round(resistanceFor(this.model, target, this.preferredCadence()));
      const onTarget = isOnTarget(seg, this.baselineW, powerW, cadence);
      if (resistance === null) {
        cue = { type: 'up', text: `Knob ~${wantR}` };
      } else if (onTarget) {
        cue = { type: 'ok', text: `Knob ${Math.round(resistance)} · on target` };
      } else {
        const have = Math.round(resistance);
        const dir = powerW < target ? 'up' : 'down';
        cue = { type: dir, text: have === wantR ? `${dir === 'up' ? 'Pedal faster' : 'Ease off'}` : `Knob ${have} → ${wantR}` };
      }
    }

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
      zone: zoneOf(seg.pct),
      stepLeft: seg.start + seg.dur - this.t,
      targetW: Math.round(targetWatts(seg, this.baselineW)),
      powerW: Math.round(powerW),
      cadence: Math.round(cadence),
      resistance: resistance === null ? null : Math.round(resistance),
      onTarget: isOnTarget(seg, this.baselineW, powerW, cadence),
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
        return {
          label: s.label,
          avgW: so.total ? Math.round(so.powerSum / so.total) : 0,
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
