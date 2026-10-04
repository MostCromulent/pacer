// Ghosts: a distance-over-time trace to race against.

import { stepSpeed } from './physics.js';

export class Ghost {
  /**
   * @param {'pb'|'last'|'pacer'} kind
   * @param {string} label  short tag shown above the ghost rider
   * @param {number[]} dist distance in metres at each whole second (dist[0] = 0)
   * @param {number[]} [cadence] rpm for each second, used only to animate the pedals
   */
  constructor(kind, label, dist, cadence = null) {
    this.kind = kind;
    this.label = label;
    this.dist = dist;
    this.cadence = cadence;
  }

  cadenceAt(t) {
    if (!this.cadence?.length) return null;
    return this.cadence[Math.max(0, Math.min(this.cadence.length - 1, Math.floor(t)))];
  }

  /** Metres per second around time t. */
  speedAt(t) {
    return this.distanceAt(t + 0.5) - this.distanceAt(Math.max(0, t - 0.5));
  }

  distanceAt(t) {
    const d = this.dist;
    if (!d.length) return 0;
    if (t <= 0) return d[0];
    const i = Math.floor(t);
    if (i >= d.length - 1) return d[d.length - 1];
    const f = t - i;
    return d[i] + (d[i + 1] - d[i]) * f;
  }

  get finalDistance() {
    return this.dist.length ? this.dist[this.dist.length - 1] : 0;
  }
}

/** Target power in watts for a segment. Sprints aim at their % like any other step. */
export function targetWatts(segment, baselineW) {
  return (segment.pct / 100) * baselineW;
}

/**
 * A rider who hits every target exactly. `wattsFor(segment)` gives each step's
 * target watts; by default it's the step's % of baseline.
 */
export function pacerGhost(workout, baselineW, wattsFor = (seg) => targetWatts(seg, baselineW)) {
  const dist = [0];
  let v = 0;
  let d = 0;
  let si = 0;
  for (let t = 0; t < workout.totalS; t++) {
    while (si < workout.segments.length - 1 && t >= workout.segments[si].start + workout.segments[si].dur) si++;
    const w = wattsFor(workout.segments[si]);
    // Integrate in quarter-second steps to match the live engine closely.
    for (let k = 0; k < 4; k++) {
      v = stepSpeed(v, w, 0.25);
      d += v * 0.25;
    }
    dist.push(Math.round(d * 10) / 10);
  }
  return new Ghost('pacer', 'PACER', dist);
}

export function ghostFromRide(ride, kind) {
  return new Ghost(kind, kind === 'pb' ? 'PB' : 'LAST', ride.samples.d, ride.samples.c);
}
