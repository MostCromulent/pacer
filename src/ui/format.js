// How numbers are written for the rider.

/** Seconds as m:ss, or h:mm:ss past an hour. */
export function fmtClock(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtKm(m) {
  return `${(m / 1000).toFixed(1)} km`;
}

/** A gap to the ghost, signed: "+120 m", "−1.25 km". */
export function fmtGap(m) {
  const a = Math.abs(Math.round(m));
  if (a === 0) return '0 m';
  const sign = m >= 0 ? '+' : '−';
  return a >= 1000 ? `${sign}${(a / 1000).toFixed(2)} km` : `${sign}${a} m`;
}

/** "Today", or a short date. */
export function fmtDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One decimal place. */
export const round1 = (x) => Math.round(x * 10) / 10;
