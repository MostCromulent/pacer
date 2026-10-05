// Small helpers shared by the core modules.

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Round to the nearest multiple of `unit` (seconds, mostly). */
export function roundTo(x, unit = 15) {
  return Math.round(x / unit) * unit;
}

/**
 * How much longer efforts get on a longer ride: lengths grow with the square
 * root of the time available (20 minutes = 1), between 0.85 and 1.8.
 */
export function stretchFor(budgetS) {
  return clamp(Math.sqrt(budgetS / 1200), 0.85, 1.8);
}

/** Random draws from a seeded generator: a number in a range, or a whole one. */
export function draws(rand) {
  const between = (lo, hi) => lo + rand() * (hi - lo);
  return { between, int: (lo, hi) => Math.round(between(lo, hi)) };
}

/** A generator of numbers from 0 to 1 that always gives the same run for the same whole-number seed. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Watts rise with about this power of cadence at a fixed resistance. Bikes
 * differ a little; this is for planning a ride, not for judging one.
 */
export const CADENCE_POWER = 1.6;

/**
 * The effort of a step ridden on another step's resistance at a different
 * cadence, as a % of baseline. (Cadences are called to the nearest five.)
 */
export function heldEffort(basePct, baseCadence, cadence) {
  return basePct * (roundTo(cadence, 5) / roundTo(baseCadence, 5)) ** CADENCE_POWER;
}
