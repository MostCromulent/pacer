// Learning the resistance model from ordinary riding.
//
// A bike that reports its resistance level hands us (resistance, cadence, watts)
// with every reading, so each ride measures the console's formula a little more.
// Readings are pooled into bins, one per resistance level and 5 rpm of cadence,
// which stays small however long you ride: a bin holds a count and two sums.
//
//   bins[level][cadenceBucket] = [count, sum of ln(cadence), sum of ln(watts)]

import { DEFAULT_MODEL, fitModel } from './resistance.js';

const CADENCE_BUCKET = 5;
const STEADY_RPM = 3; // cadence change between readings that still counts as steady
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

export function fitBins(bins, prior = DEFAULT_MODEL) {
  return fitModel(binsToSamples(bins), prior);
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
  }

  observe(reading) {
    const prev = this._prev;
    this._prev = reading;
    if (!prev || !usable(reading)) return false;
    const steady = Math.round(prev.resistance) === Math.round(reading.resistance)
      && Math.abs(prev.cadence - reading.cadence) <= STEADY_RPM;
    if (!steady || !addToBins(this.bins, reading)) return false;
    this.added += 1;
    return true;
  }

  /** Forget the last reading, e.g. across a pause. */
  rest() {
    this._prev = null;
  }
}
