// Resistance model: how the bike turns knob position and cadence into watts.
//
// Spin bikes without a power meter (like the Schwinn 800IC / IC4) compute watts
// from cadence and the resistance level with a fixed formula. We model it as
//   ln(P) = a + b * ln(cadence) + c * r + d * r^2
// which fits a smooth, monotonic curve over the 1-100 knob range. Once fitted,
// it runs backwards: watts + cadence -> knob level, and target watts -> knob hint.

export const DEFAULT_MODEL = Object.freeze({
  a: -2.602,
  b: 1.3,
  c: 0.04095,
  d: -8.375e-5,
  calibrated: false,
});

const R_MIN = 1;
const R_MAX = 100;

export function powerFor(model, resistance, cadence) {
  if (!(cadence > 0)) return 0;
  const r = clamp(resistance, R_MIN, R_MAX);
  return Math.exp(model.a + model.b * Math.log(cadence) + model.c * r + model.d * r * r);
}

/** Knob level that produces `watts` at `cadence`. Clamped to 1-100. */
export function resistanceFor(model, watts, cadence) {
  if (!(watts > 0) || !(cadence > 0)) return R_MIN;
  const k = model.a + model.b * Math.log(cadence) - Math.log(watts);
  const { c, d } = model;
  let r;
  if (Math.abs(d) < 1e-12) {
    r = -k / c;
  } else {
    const disc = c * c - 4 * d * k;
    if (disc < 0) {
      r = -c / (2 * d);
    } else {
      const s = Math.sqrt(disc);
      const roots = [(-c + s) / (2 * d), (-c - s) / (2 * d)];
      const inRange = roots.filter((x) => x >= R_MIN - 5 && x <= R_MAX + 5);
      r = inRange.length ? Math.min(...inRange) : roots.reduce((a, b) => (Math.abs(a - 50) < Math.abs(b - 50) ? a : b));
    }
  }
  return clamp(r, R_MIN, R_MAX);
}

/**
 * Fit the model to calibration samples [{ resistance, cadence, power }].
 * Calibration rides usually hold a similar cadence, which leaves the cadence
 * exponent poorly determined; in that case keep b fixed and fit the rest.
 */
export function fitModel(samples, fallback = DEFAULT_MODEL) {
  const pts = samples.filter((s) => s.power > 5 && s.cadence > 20 && s.resistance >= R_MIN);
  const levels = new Set(pts.map((s) => Math.round(s.resistance)));
  if (pts.length < 6 || levels.size < 3) return null;

  const lnCad = pts.map((s) => Math.log(s.cadence));
  const mean = lnCad.reduce((a, b) => a + b, 0) / lnCad.length;
  const variance = lnCad.reduce((a, b) => a + (b - mean) ** 2, 0) / lnCad.length;

  if (variance > 0.004) {
    const X = pts.map((s, i) => [1, lnCad[i], s.resistance, s.resistance ** 2]);
    const y = pts.map((s) => Math.log(s.power));
    const beta = leastSquares(X, y);
    if (beta && beta[1] > 0.3 && beta[1] < 3) {
      return { a: beta[0], b: beta[1], c: beta[2], d: beta[3], calibrated: true };
    }
  }
  const b = fallback.b;
  const X = pts.map((s) => [1, s.resistance, s.resistance ** 2]);
  const y = pts.map((s, i) => Math.log(s.power) - b * lnCad[i]);
  const beta = leastSquares(X, y);
  if (!beta) return null;
  return { a: beta[0], b, c: beta[1], d: beta[2], calibrated: true };
}

/** Root-mean-square error of the model in watts, for showing fit quality. */
export function modelError(model, samples) {
  if (!samples.length) return 0;
  const se = samples.reduce((a, s) => a + (powerFor(model, s.resistance, s.cadence) - s.power) ** 2, 0);
  return Math.sqrt(se / samples.length);
}

function leastSquares(X, y) {
  const n = X[0].length;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += X[r][i] * X[r][j];
      A[i][n] += X[r][i] * y[r];
    }
  }
  // Gauss-Jordan elimination with partial pivoting on the normal equations.
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col] / A[col][col];
      for (let k = col; k <= n; k++) A[row][k] -= f * A[col][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
