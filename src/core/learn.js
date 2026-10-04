// Learning the resistance model from ordinary riding.
//
// A bike that reports its resistance level hands us (resistance, cadence, watts)
// with every reading, so each ride measures the console's formula a little more.
// Readings are pooled into bins, one per resistance level and 5 rpm of cadence,
// which stays small however long you ride: a bin holds a count and two sums.
//
//   bins[level][cadenceBucket] = [count, sum of ln(cadence), sum of ln(watts)]

import { DEFAULT_MODEL, fitModel } from './resistance.js';
import { clamp } from './util.js';

const CADENCE_BUCKET = 5;
const STEADY_RPM = 3; // cadence change between readings that still counts as steady
const STEADY_READINGS = 3; // this many steady readings in a row before one is kept

// The cadence exponent says how watts change with cadence. It is only worked
// out from levels ridden properly at two cadences well apart, and a ride may
// only move it a little: a few readings while the cadence was drifting are
// not evidence about the bike.
const EXPONENT_MIN_PER_CADENCE = 5;
const EXPONENT_MIN_SPREAD_RPM = 15;
const EXPONENT_MAX_STEP = 0.03;
export const MIN_LEVEL_READINGS = 5; // a level needs this many before it shapes the model

function usable({ resistance, cadence, power }) {
  return power > 5 && cadence > 20 && cadence < 160 && resistance >= 1 && resistance <= 100;
}

export function addToBins(bins, reading) {
  if (!usable(reading)) return false;
  const level = Math.round(reading.resistance);
  const bucket = Math.round(reading.cadence / CADENCE_BUCKET) * CADENCE_BUCKET;
  const row = (bins[level] ??= {});
  const cell = (row[bucket] ??= [0, 0, 0]);
  cell[0] += 1;
  cell[1] += Math.log(reading.cadence);
  cell[2] += Math.log(reading.power);
  return true;
}

/** How many readings each level holds: { level: count }. */
export function levelCounts(bins) {
  const out = {};
  for (const [level, row] of Object.entries(bins)) {
    out[level] = Object.values(row).reduce((n, cell) => n + cell[0], 0);
  }
  return out;
}

export function totalReadings(bins) {
  return Object.values(levelCounts(bins)).reduce((a, b) => a + b, 0);
}

/** One weighted sample per bin, leaving out levels that have barely been ridden. */
export function binsToSamples(bins, minPerLevel = MIN_LEVEL_READINGS) {
  const counts = levelCounts(bins);
  const out = [];
  for (const [level, row] of Object.entries(bins)) {
    if (counts[level] < minPerLevel) continue;
    for (const [n, sumLnC, sumLnP] of Object.values(row)) {
      out.push({ resistance: Number(level), cadence: Math.exp(sumLnC / n), power: Math.exp(sumLnP / n), weight: n });
    }
  }
  return out;
}

/**
 * The cadence exponent, from levels with enough readings at two cadences at
 * least 15 rpm apart. Null when no level has been ridden that way.
 */
export function cadenceExponent(bins) {
  let sxy = 0;
  let sxx = 0;
  for (const row of Object.values(bins)) {
    const cells = Object.entries(row).filter(([, cell]) => cell[0] >= EXPONENT_MIN_PER_CADENCE);
    const buckets = cells.map(([bucket]) => Number(bucket));
    if (cells.length < 2 || Math.max(...buckets) - Math.min(...buckets) < EXPONENT_MIN_SPREAD_RPM) continue;
    const n = cells.reduce((a, [, cell]) => a + cell[0], 0);
    const mx = cells.reduce((a, [, [, sumLnC]]) => a + sumLnC, 0) / n;
    const my = cells.reduce((a, [, [, , sumLnP]]) => a + sumLnP, 0) / n;
    for (const [, [count, sumLnC, sumLnP]] of cells) {
      const x = sumLnC / count - mx;
      sxy += count * x * (sumLnP / count - my);
      sxx += count * x * x;
    }
  }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  return b > 0.5 && b < 3 ? b : null;
}

/**
 * Fit the model to everything in the bins.
 * With `cautious` (learning from a ride, as opposed to calibrating), the
 * cadence exponent moves at most a little from the model already in use.
 */
export function fitBins(bins, prior = DEFAULT_MODEL, { cautious = false } = {}) {
  let b = cadenceExponent(bins);
  if (cautious && prior.calibrated) {
    b = b === null ? prior.b : clamp(b, prior.b - EXPONENT_MAX_STEP, prior.b + EXPONENT_MAX_STEP);
  }
  return fitModel(binsToSamples(bins), prior, b === null ? {} : { b });
}

/**
 * Feeds ride readings into the bins, keeping only steady ones: the watts on the
 * console lag a moment behind a change of resistance or cadence.
 */
export class Learner {
  constructor(bins = {}) {
    this.bins = bins;
    this.added = 0;
    this._prev = null;
    this._steady = 0; // readings in a row at this resistance and cadence
  }

  observe(reading) {
    const prev = this._prev;
    this._prev = reading;
    const steady = prev && usable(reading)
      && Math.round(prev.resistance) === Math.round(reading.resistance)
      && Math.abs(prev.cadence - reading.cadence) <= STEADY_RPM;
    this._steady = steady ? this._steady + 1 : 1;
    if (this._steady < STEADY_READINGS || !addToBins(this.bins, reading)) return false;
    this.added += 1;
    return true;
  }

  /** Forget the run so far, e.g. across a pause. */
  rest() {
    this._prev = null;
    this._steady = 0;
  }
}
