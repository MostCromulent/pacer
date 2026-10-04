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
