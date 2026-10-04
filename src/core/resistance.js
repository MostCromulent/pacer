// Resistance model: how the bike turns resistance level and cadence into watts.
//
// Spin bikes without a power meter (like the Schwinn 800IC / IC4) compute watts
// from cadence and the resistance level with a fixed formula, which we never
// see. We split it into a cadence part and a resistance part:
//
//   ln(P) = b * ln(cadence) + g(r)
//
// - The uncalibrated default uses a smooth curve for g: g(r) = a + c*r + d*r^2.
// - A calibrated model stores g as a table measured at each calibration level
//   and joins the dots, so it follows consoles that use stepped lookup tables.
//
// Either way the model also runs backwards: watts + cadence -> resistance, and
// target watts at a target cadence -> the resistance to set.

export const DEFAULT_MODEL = Object.freeze({
  a: -2.602,
  b: 1.3,
  c: 0.04095,
  d: -8.375e-5,
  calibrated: false,
});

const R_MIN = 1;
const R_MAX = 100;
const MIN_SLOPE = 0.004; // ln(watts) per level; keeps extrapolation increasing

/**
 * The calibration ride. Two levels are ridden at both a slow and a fast cadence:
 * that's what pins down how watts change with cadence, which a ride at one
 * steady cadence can't tell us. Heavy levels pair with slow cadences, down to the
 * 60 rpm that climbs are ridden at, so no step asks for silly watts.
 */
export const CALIBRATION_STEPS = Object.freeze([
  { resistance: 20, cadence: 85 },
  { resistance: 30, cadence: 70 },
  { resistance: 30, cadence: 100 },
  { resistance: 40, cadence: 85 },
  { resistance: 50, cadence: 70 },
  { resistance: 50, cadence: 100 },
  { resistance: 60, cadence: 85 },
  { resistance: 70, cadence: 65 },
  { resistance: 80, cadence: 60 },
]);

function g(model, r) {
  if (model.knots) return interpolate(model.knots, r);
  return model.a + model.c * r + model.d * r * r;
}

export function powerFor(model, resistance, cadence) {
  if (!(cadence > 0)) return 0;
  const r = clamp(resistance, R_MIN, R_MAX);
  return Math.exp(model.b * Math.log(cadence) + g(model, r));
}

/** Resistance level that produces `watts` at `cadence`. Clamped to 1-100. */
export function resistanceFor(model, watts, cadence) {
  if (!(watts > 0) || !(cadence > 0)) return R_MIN;
  const want = Math.log(watts) - model.b * Math.log(cadence);
  if (model.knots) return clamp(inverse(model.knots, want), R_MIN, R_MAX);

  const k = model.a - want;
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
      r = inRange.length ? Math.min(...inRange) : roots.reduce((p, q) => (Math.abs(p - 50) < Math.abs(q - 50) ? p : q));
    }
  }
  return clamp(r, R_MIN, R_MAX);
}

/**
 * Fit a calibrated model to samples [{ resistance, cadence, power }]. A sample
 * may carry a `weight`: the number of readings it stands for (default 1).
 *
 * 1. The cadence exponent b comes from changes in cadence *within* a level
 *    (the calibration ride's paired steps), where resistance is fixed, so the
 *    resistance curve can't soak it up. Without that, fall back to a smooth fit
 *    across levels, and failing that to the prior.
 * 2. With b known, each level's g is the average of ln(P) - b*ln(cadence),
 *    forced to rise with resistance.
 */
export function fitModel(samples, prior = DEFAULT_MODEL) {
  const pts = samples.filter((s) => s.power > 5 && s.cadence > 20 && s.resistance >= R_MIN && s.resistance <= R_MAX);
  const byLevel = groupByLevel(pts);
  if (pts.length < 6 || byLevel.size < 3) return null;

  let b = withinLevelExponent(byLevel);
  if (b === null) b = acrossLevelExponent(pts);
  if (b === null) b = prior.b;

  const levels = [...byLevel.entries()]
    .map(([r, list]) => {
      const n = list.reduce((acc, s) => acc + weightOf(s), 0);
      return {
        r,
        n,
        g: list.reduce((acc, s) => acc + weightOf(s) * (Math.log(s.power) - b * Math.log(s.cadence)), 0) / n,
      };
    })
    .sort((p, q) => p.r - q.r);
  const knots = monotone(levels).map(({ r, g: v }) => [r, v]);
  return { kind: 'table', b, knots, calibrated: true };
}

/**
 * Honest accuracy: leave each level out, fit on the rest, and see how far the
 * model's resistance for that level's readings lands from the true level.
 * Returns errors in resistance levels.
 */
export function crossValidate(samples, prior = DEFAULT_MODEL) {
  const byLevel = groupByLevel(samples.filter((s) => s.power > 5 && s.cadence > 20));
  const results = [];
  for (const [level, list] of byLevel) {
    const rest = samples.filter((s) => Math.round(s.resistance) !== level);
    const m = fitModel(rest, prior);
    if (!m) continue;
    // Each cadence ridden at this level is checked separately.
    for (const group of splitByCadence(list)) {
      const c = mean(group.map((s) => s.cadence));
      const p = mean(group.map((s) => s.power));
      results.push({ level, cadence: c, predicted: resistanceFor(m, p, c) });
    }
  }
  if (!results.length) return null;
  const errs = results.map((x) => Math.abs(x.predicted - x.level));
  const interior = results.filter((x) => x.level !== Math.min(...byLevel.keys()) && x.level !== Math.max(...byLevel.keys()));
  const interiorErrs = interior.map((x) => Math.abs(x.predicted - x.level));
  return {
    meanAbs: mean(errs),
    maxAbs: Math.max(...errs),
    interiorMeanAbs: interiorErrs.length ? mean(interiorErrs) : mean(errs),
    interiorMaxAbs: interiorErrs.length ? Math.max(...interiorErrs) : Math.max(...errs),
    results,
  };
}

// --- helpers -------------------------------------------------------------

function groupByLevel(pts) {
  const m = new Map();
  for (const s of pts) {
    const r = Math.round(s.resistance);
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(s);
  }
  return m;
}

function weightOf(s) {
  return s.weight ?? 1;
}

function splitByCadence(list) {
  // Calibration pairs differ by ~30 rpm; anything closer is one group.
  const sorted = [...list].sort((p, q) => p.cadence - q.cadence);
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].cadence - sorted[i - 1].cadence > 12) groups.push([]);
    groups[groups.length - 1].push(sorted[i]);
  }
  return groups;
}

function withinLevelExponent(byLevel) {
  let sxy = 0;
  let sxx = 0;
  for (const list of byLevel.values()) {
    const xs = list.map((s) => Math.log(s.cadence));
    const ys = list.map((s) => Math.log(s.power));
    const ws = list.map(weightOf);
    const n = ws.reduce((a, w) => a + w, 0);
    const mx = xs.reduce((a, x, i) => a + ws[i] * x, 0) / n;
    const my = ys.reduce((a, y, i) => a + ws[i] * y, 0) / n;
    for (let i = 0; i < xs.length; i++) {
      sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
      sxx += ws[i] * (xs[i] - mx) ** 2;
    }
  }
  // Needs a deliberate cadence change, not just a rider's drift.
  if (sxx < 0.15) return null;
  const b = sxy / sxx;
  return b > 0.5 && b < 3 ? b : null;
}

function acrossLevelExponent(pts) {
  const xs = pts.map((s) => Math.log(s.cadence));
  const mx = mean(xs);
  if (mean(xs.map((x) => (x - mx) ** 2)) < 0.004) return null;
  const X = pts.map((s, i) => [1, xs[i], s.resistance, s.resistance ** 2]);
  const beta = leastSquares(X, pts.map((s) => Math.log(s.power)));
  return beta && beta[1] > 0.5 && beta[1] < 3 ? beta[1] : null;
}

/** Pool-adjacent-violators: the closest non-decreasing sequence, then strictly rising. */
function monotone(levels) {
  const blocks = levels.map((l) => ({ ...l, w: l.n, members: [l] }));
  for (let i = 0; i < blocks.length - 1;) {
    if (blocks[i].g > blocks[i + 1].g) {
      const a = blocks[i];
      const z = blocks[i + 1];
      const w = a.w + z.w;
      blocks.splice(i, 2, { g: (a.g * a.w + z.g * z.w) / w, w, members: [...a.members, ...z.members] });
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  const out = [];
  for (const blk of blocks) for (const m of blk.members) out.push({ r: m.r, g: blk.g });
  for (let i = 1; i < out.length; i++) {
    const minG = out[i - 1].g + MIN_SLOPE * (out[i].r - out[i - 1].r) * 0.25;
    if (out[i].g < minG) out[i].g = minG;
  }
  return out;
}

function interpolate(knots, r) {
  const n = knots.length;
  if (n === 1) return knots[0][1];
  if (r <= knots[0][0]) return knots[0][1] + endSlope(knots, 0) * (r - knots[0][0]);
  if (r >= knots[n - 1][0]) return knots[n - 1][1] + endSlope(knots, n - 2) * (r - knots[n - 1][0]);
  let i = 0;
  while (r > knots[i + 1][0]) i++;
  const [r0, g0] = knots[i];
  const [r1, g1] = knots[i + 1];
  return g0 + ((g1 - g0) * (r - r0)) / (r1 - r0);
}

function inverse(knots, want) {
  const n = knots.length;
  if (n === 1) return knots[0][0];
  if (want <= knots[0][1]) return knots[0][0] + (want - knots[0][1]) / endSlope(knots, 0);
  if (want >= knots[n - 1][1]) return knots[n - 1][0] + (want - knots[n - 1][1]) / endSlope(knots, n - 2);
  let i = 0;
  while (want > knots[i + 1][1]) i++;
  const [r0, g0] = knots[i];
  const [r1, g1] = knots[i + 1];
  return g1 === g0 ? r0 : r0 + ((want - g0) * (r1 - r0)) / (g1 - g0);
}

function endSlope(knots, i) {
  const [r0, g0] = knots[i];
  const [r1, g1] = knots[i + 1];
  return Math.max(MIN_SLOPE, (g1 - g0) / (r1 - r0));
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

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
