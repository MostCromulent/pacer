// Virtual speed from power on a flat road. The bike's own speed readout is
// derived from cadence alone on many spin bikes, which would reward spinning
// fast at no resistance; converting power to speed keeps the race honest.

const MASS_KG = 85;
const GRAVITY = 9.81;
const CRR = 0.005;
const AIR_DENSITY = 1.225;
const CDA = 0.32;

/** Steady-state speed in m/s for a given power in watts. */
export function speedFromPower(watts) {
  if (!(watts > 0)) return 0;
  let v = 8;
  for (let k = 0; k < 40; k++) {
    const f = CRR * MASS_KG * GRAVITY * v + 0.5 * AIR_DENSITY * CDA * v ** 3 - watts;
    const df = CRR * MASS_KG * GRAVITY + 1.5 * AIR_DENSITY * CDA * v * v;
    const next = Math.max(0.05, v - f / df);
    if (Math.abs(next - v) < 1e-6) return next;
    v = next;
  }
  return v;
}

// Speed doesn't jump instantly when power changes; ease toward the target.
const TIME_CONSTANT_S = 3;

export function stepSpeed(current, watts, dt) {
  const target = speedFromPower(watts);
  const a = 1 - Math.exp(-dt / TIME_CONSTANT_S);
  return current + (target - current) * a;
}
