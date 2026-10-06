// The ride engine: integrates distance, tracks the workout, the ghost race and
// sprint gates. Pure logic, no DOM; driven by `update(dt, input)`.

import { stepSpeed } from './physics.js';
import { segmentIndexAt, zoneOf } from './workout.js';
import { resistanceFor, powerFor } from './resistance.js';
import { targetWatts } from './ghost.js';
import { roundTo } from './util.js';
import { onKnob, FULL_KNOB } from './knob.js';

const STALE_INPUT_S = 3;
const STEP_WARNING_S = 10;
export const SHORT_STEP_S = 25;
export const EASY_PACE_PCT = 70; // comfortable flat-road riding, as a % of baseline: what the rider's "easy pace" stands for
// Targets are given as bands of ten in round numbers, the way an instructor
// calls them: a cadence of 80-90 and a resistance of 35-45. Each is the exact
// target rounded to the nearest five, and five either side.
const ROUND_TO = 5;
const CADENCE_TOLERANCE = 5;
const RESISTANCE_TOLERANCE = 5;
// Nothing is ridden lighter than a recovery at an easy cadence. A step easier
// than that slows the legs instead of taking more off the dial, down to SLOWEST_EASY.
const LIGHTEST = { pct: 55, cadence: 80 };
const SLOWEST_EASY = 65;
const CREEP_TOLERANCE = 1; // a creeping climb moves a level or two at a time, so it is exact
export const EFFORT_MIN = 0.5;
export const EFFORT_MAX = 1.5;
export const EFFORT_STEP = 0.1; // about one resistance block

/**
 * What to aim for in a step: power, cadence, and the resistance that gives that
 * power at that cadence (from the resistance model), plus the on-target ranges.
 * Steps marked `hold` keep the previous step's resistance; their watts follow
 * from the lower cadence.
 */
/**
 * The band of ten resistance levels around `resistance`: [40, 50] for 43.
 * `cap` is the highest level allowed (100, or lower for a gentle ride); the
 * band stops there, and never starts below 1.
 */
export function resistanceBlock(resistance, cap = 100) {
  const hi = Math.min(cap, roundTo(resistance, ROUND_TO) + RESISTANCE_TOLERANCE);
  return [Math.max(1, hi - 2 * RESISTANCE_TOLERANCE), Math.max(hi, 2 * RESISTANCE_TOLERANCE)];
}

/** The resistance of the easy pace, on the 1-100 scale: what a knob with no numbers is measured from. */
export function easyPaceResistance(model, baselineW, easyCadence) {
  return resistanceFor(model, (EASY_PACE_PCT / 100) * baselineW, easyCadence);
}

export function stepTargets(seg, segments, baselineW, model) {
  let cadence = roundTo(seg.cadence ?? 85, ROUND_TO);
  let watts = targetWatts(seg, baselineW);
  // The exact resistance the model works out; the rider is shown the block it falls in.
  let exact = resistanceFor(model, watts, cadence);
  // Too light to be worth dialling: the same effort at a slower cadence.
  const lightest = resistanceFor(model, (LIGHTEST.pct / 100) * baselineW, LIGHTEST.cadence);
  while (!seg.hold && seg.kind !== 'sprint' && exact < lightest && cadence > SLOWEST_EASY) {
    cadence -= ROUND_TO;
    exact = resistanceFor(model, watts, cadence);
  }
  if (seg.hold) {
    // Back to the step that set the resistance, through any others that held it.
    let i = segments.indexOf(seg) - 1;
    while (i > 0 && segments[i].hold) i--;
    const base = segments[i];
    if (base && !base.hold) {
      exact = stepTargets(base, segments, baselineW, model).exactResistance;
      watts = powerFor(model, exact, cadence);
    }
  }
  const cap = seg.resistanceCap ?? 100;
  if (exact > cap) {
    exact = cap;
    watts = powerFor(model, exact, cadence);
  }
  const resistance = Math.round(exact);
  const wattsTol = Math.max(10, watts * 0.06);
  const sprint = seg.kind === 'sprint';
  const [lo, hi] = seg.creep
    ? [Math.max(1, resistance - CREEP_TOLERANCE), Math.min(cap, resistance + CREEP_TOLERANCE)]
    : resistanceBlock(exact, cap);
  // The ranges that count as on target. Sprints have no upper limit.
  return {
    watts: Math.round(watts),
    cadence,
    resistance,
    exactResistance: exact,
    // A creeping climb is called as one number ("aim 37"), not a block.
    resistanceIsExact: !!seg.creep,
    cadenceRange: [cadence - CADENCE_TOLERANCE, sprint ? null : cadence + CADENCE_TOLERANCE],
    resistanceRange: [lo, sprint ? null : hi],
    wattsRange: sprint ? [Math.round(baselineW * 1.2), null] : [Math.round(watts - wattsTol), Math.round(watts + wattsTol)],
  };
}

/** Power-based check, used when the resistance position isn't known. */
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
  /**
   * `targetMode` is what the rider is shown and follows: 'resistance' (with cadence) or 'watts'.
   *
   * A ride on a basic bike, with no readings, is `follow`: the rider follows
   * the targets and the clock runs on its own. Nothing is scored and there is
   * no ghost; the ride keeps a speed and distance from the targets only so
   * that the road can move. `knob` is the top level of the bike's resistance
   * knob (0 if it has no numbers; see knob.js) and `easyCadence` the easy
   * pace's cadence, which a knob with no numbers is measured from.
   */
  constructor({ workout, baselineW, model, ghost, targetMode = 'resistance', follow = false, knob = FULL_KNOB, easyCadence = 80 }) {
    this.workout = workout;
    this.baselineW = baselineW;
    this.model = model;
    this.ghost = follow ? null : ghost;
    this.targetMode = follow ? 'resistance' : targetMode;
    this.follow = follow;
    this.knob = knob;
    this.easyResistance = easyPaceResistance(model, baselineW, easyCadence);
    // Effort multiplier the rider can change mid-ride; scales every power target.
    this.effort = 1;
    this._effortS = 0;

    this.t = 0;
    this.dist = 0;
    this.speed = 0;
    this.input = { powerW: 0, cadence: 0, resistance: null, at: -Infinity };
    this.samples = { d: [0], p: [], c: [], r: [], e: [] }; // per second: distance, power, cadence, resistance, effort
    this.onTargetS = 0;
    this.segOnTarget = workout.segments.map(() => ({ on: 0, total: 0, powerSum: 0, cadSum: 0, resistanceSum: 0, resistanceT: 0 }));
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

    const si = segmentIndexAt(this.workout, Math.max(0, this.t - 1e-6));
    const seg = this.workout.segments[si];
    this.speed = stepSpeed(this.speed, this.follow ? this.targetsFor(seg).watts : powerW, realDt);
    this.dist += this.speed * realDt;
    this._effortS += this.effort * realDt;
    if (this.follow) {
      this._steps(si, events);
      return this._finish(events);
    }

    const resistance = stale ? null : this.currentResistance();
    const on = this.status(seg, powerW, cadence, resistance).onTarget;
    if (on) this.onTargetS += realDt;
    const so = this.segOnTarget[si];
    so.total += realDt;
    so.powerSum += powerW * realDt;
    so.cadSum += cadence * realDt;
    if (resistance !== null) { so.resistanceSum += resistance * realDt; so.resistanceT += realDt; }
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
      this.samples.e.push(this.effort);
      this._accum = { p: 0, c: 0, r: 0, n: 0 };
    }

    this._steps(si, events);

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

    return this._finish(events);
  }

  /** Step changes, and the heads-up before them, added to `events`. */
  _steps(si, events) {
    // Moving on to a step that looks the same to the rider is no change at all.
    const segs = this.workout.segments;
    if (si !== this._lastSeg) {
      if (!this.looksSame(segs[this._lastSeg], segs[si])) events.push('stepChange');
      this._lastSeg = si;
    }
    const [first, last] = this.runOf(si);
    const runEnd = segs[last].start + segs[last].dur;
    // No heads-up inside short HIIT reps: the change chime itself is the cue.
    if (segs[last + 1] && runEnd - segs[first].start >= SHORT_STEP_S) {
      if (runEnd - this.t <= STEP_WARNING_S && !this._warned.has(last)) {
        this._warned.add(last);
        events.push('stepSoon');
      }
    }
  }

  /** The finish, added to `events`, which is returned. */
  _finish(events) {
    if (this.t >= this.workout.totalS) {
      this.done = true;
      events.push('done');
    }
    return events;
  }

  /** Everything needed to pick this ride up again later, as plain data. */
  save() {
    const { t, dist, speed, effort, _effortS, samples, onTargetS, segOnTarget, gateResults, _activeGate, _lastSeg, _lastAhead, _accum } = this;
    return { t, dist, speed, effort, _effortS, samples, onTargetS, segOnTarget, gateResults, _activeGate, _lastSeg, _lastAhead, _accum, warned: [...this._warned] };
  }

  /** Put back what save() returned. The bike's readings start afresh. */
  restore(saved) {
    const { warned, ...rest } = saved;
    Object.assign(this, rest);
    this._warned = new Set(warned);
    this.samples.e ??= this.samples.p.map(() => this.effort); // saved before effort was recorded
    this.input.at = -Infinity;
    return this;
  }

  /**
   * Carry on after the finish. The ride itself is over and its result stands;
   * from here the rider cruises at `seg`, which is shown but not scored, and
   * the time and distance are kept apart in `extra`.
   */
  keepGoing(seg) {
    this.extraSeg = { position: 'seated', ...seg, start: this.workout.totalS, dur: Infinity };
    this.extra = { s: 0, dist: 0 };
  }

  /** Advance the time after the finish by `dt` seconds. */
  updateExtra(dt) {
    if (!this.done || !this.extra) return;
    this.speed = stepSpeed(this.speed, this.follow ? this.targetsFor(this.extraSeg).watts : this.input.powerW, dt);
    this.extra.s += dt;
    this.extra.dist += this.speed * dt;
  }

  currentResistance() {
    if (this.input.resistance !== null) return this.input.resistance;
    if (this.input.powerW > 5 && this.input.cadence > 20) {
      return resistanceFor(this.model, this.input.powerW, this.input.cadence);
    }
    return null;
  }

  /** Set the effort multiplier (0.5-1.5, in 5% steps). Returns the new value. */
  setEffort(value) {
    const snapped = Math.round(value / EFFORT_STEP) * EFFORT_STEP;
    this.effort = Math.round(Math.min(EFFORT_MAX, Math.max(EFFORT_MIN, snapped)) * 100) / 100;
    return this.effort;
  }

  /** Make the ride easier (-1) or harder (+1) by one step. */
  nudgeEffort(steps) {
    return this.setEffort(this.effort + steps * EFFORT_STEP);
  }

  /**
   * Whether two steps look the same to this rider: the same position, and the
   * same targets on screen. Steps a few points of effort apart often are,
   * since targets are rounded to the nearest five; which ones depends on the
   * bike, the rider's easy pace and the effort setting.
   */
  looksSame(a, b) {
    if (a.position !== b.position || (a.kind === 'sprint') !== (b.kind === 'sprint')) return false;
    const [ta, tb] = [this.targetsFor(a), this.targetsFor(b)];
    if (this.targetMode === 'watts') return String(ta.wattsRange) === String(tb.wattsRange);
    return ta.cadence === tb.cadence && String(ta.resistanceRange) === String(tb.resistanceRange);
  }

  /**
   * The run of steps around step `si` that look the same to the rider, as
   * [first, last]. To the rider a run is one step: one countdown, and no
   * chime in the middle of it.
   */
  runOf(si) {
    const segs = this.workout.segments;
    if (this._runs?.effort !== this.effort) this._runs = { effort: this.effort, of: new Map() };
    if (!this._runs.of.has(si)) {
      let [first, last] = [si, si];
      while (first > 0 && this.looksSame(segs[first - 1], segs[first])) first--;
      while (last < segs.length - 1 && this.looksSame(segs[last], segs[last + 1])) last++;
      for (let i = first; i <= last; i++) this._runs.of.set(i, [first, last]);
    }
    return this._runs.of.get(si);
  }

  /** Baseline with the current effort applied: what targets are built from. */
  get effectiveBaselineW() {
    return this.baselineW * this.effort;
  }

  /**
   * What to aim for in a step: power, cadence, and the resistance level that gives
   * that power at that cadence (from the resistance model), on the bike's knob.
   */
  targetsFor(seg) {
    return onKnob(stepTargets(seg, this.workout.segments, this.effectiveBaselineW, this.model), this.knob, this.easyResistance);
  }

  /**
   * How the rider is doing against the step's targets.
   * Each of cadence/resistance is 'on' | 'low' | 'high' (resistance is null when unknown).
   */
  status(seg, powerW, cadence, resistance) {
    const tg = this.targetsFor(seg);
    // Inside the range is on target; a range with no top (a sprint) can't be overshot.
    const judge = (have, [lo, hi]) => {
      if (have === null) return null;
      if (have < lo) return 'low';
      return hi !== null && have > hi ? 'high' : 'on';
    };
    const cadenceStatus = judge(Math.round(cadence), tg.cadenceRange);
    const resistanceStatus = judge(resistance === null ? null : Math.round(resistance), tg.resistanceRange);
    // On target if the power is right, or if cadence and resistance both match the plan.
    const onTarget = isOnTarget(seg, this.effectiveBaselineW, powerW, cadence) || (cadenceStatus === 'on' && resistanceStatus === 'on');
    return { targets: tg, cadenceStatus, resistanceStatus, onTarget };
  }

  /** Everything the UI needs to draw a frame. */
  snapshot() {
    const w = this.workout;
    // After the finish, a rider who carries on is shown the cruise instead of the last step.
    const cruising = this.done && !!this.extraSeg;
    const si = cruising ? w.segments.length : segmentIndexAt(w, Math.max(0, this.t - 1e-6));
    const seg = cruising ? this.extraSeg : w.segments[si];
    // A ride with no readings is never short of them: there were none to lose.
    const stale = !this.follow && this.t - this.input.at > STALE_INPUT_S;
    const powerW = stale ? 0 : this.input.powerW;
    const cadence = stale ? 0 : this.input.cadence;
    const ghostDist = this.ghost?.distanceAt(this.t) ?? 0;
    const resistance = stale ? null : this.currentResistance();

    const st = this.follow ? { targets: this.targetsFor(seg), cadenceStatus: null, resistanceStatus: null, onTarget: false } : this.status(seg, powerW, cadence, resistance);
    const tg = st.targets;
    let gate = null;
    if (this._activeGate && !this.follow) {
      const g = this._activeGate;
      gate = {
        index: g.index,
        count: w.gates.length,
        left: g.end - this.t,
        you: this.dist - g.youStart,
        ghost: ghostDist - g.ghostStart,
      };
    }
    const upcoming = this.follow ? null : w.gates.find((g) => g.start > this.t);
    // The step as the rider sees it: the whole run of steps that look alike.
    const [first, last] = cruising ? [si, si] : this.runOf(si);
    const stepStart = cruising ? seg.start : w.segments[first].start;
    const stepEnd = cruising ? Infinity : w.segments[last].start + w.segments[last].dur;

    return {
      t: this.t,
      totalS: w.totalS,
      dist: this.dist,
      speed: this.speed,
      ghostDist,
      gap: this.ghost ? this.dist - ghostDist : 0,
      ghostLabel: this.ghost?.label ?? '',
      ghostSpeed: this.ghost?.speedAt(this.t) ?? 0,
      ghostCadence: this.ghost?.cadenceAt(this.t) ?? 86,
      segIndex: si,
      stepIndex: first, // the first step of the run the rider is in
      nextIndex: last + 1, // the next step that will look different (past the end, if none)
      seg,
      zone: zoneOf((tg.watts / this.effectiveBaselineW) * 100),
      stepLeft: stepEnd - this.t,
      stepDur: stepEnd - stepStart,
      targetW: tg.watts,
      targetCadence: tg.cadence,
      targetResistance: tg.resistance,
      cadenceRange: tg.cadenceRange,
      resistanceRange: tg.resistanceRange,
      resistanceIsExact: tg.resistanceIsExact,
      feel: tg.feel ?? null,
      wattsRange: tg.wattsRange,
      effort: this.effort,
      powerW: Math.round(powerW),
      cadence: Math.round(cadence),
      resistance: resistance === null ? null : Math.round(resistance),
      cadenceStatus: st.cadenceStatus,
      resistanceStatus: st.resistanceStatus,
      onTarget: st.onTarget,
      gate,
      nextGate: upcoming ? { index: upcoming.index, count: w.gates.length, inS: upcoming.start - this.t } : null,
      noSignal: stale,
      follow: this.follow,
      done: this.done,
      extra: cruising ? this.extra : null, // { s, dist } since the finish
    };
  }

  /** Final numbers for the summary screen and for saving. */
  summary() {
    const avgEffort = this.t ? Math.round((this._effortS / this.t) * 100) / 100 : 1;
    // With no readings there is only the time and the effort to report.
    if (this.follow) return { follow: true, durationS: this.t, avgEffort };
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
          avgResistance: so.resistanceT ? Math.round(so.resistanceSum / so.resistanceT) : null,
          targetCadence: tg.cadence,
          targetResistance: tg.resistance,
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
      avgEffort,
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
