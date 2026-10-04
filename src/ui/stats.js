// The statistics screen: totals, minutes per week, the list of rides, and the
// backup (export and import).

import { TYPES, parseWorkoutCode } from '../core/workout.js';
import { storage, settings } from './store.js';
import { $, showScreen } from './dom.js';
import { fmtKm } from './format.js';
import { weeksSvg, esc } from './charts.js';
import { renderSetup } from './setup.js';

const STATS_WEEKS = 8;
const STATS_ROWS = 30;

function rideName(code) {
  const p = parseWorkoutCode(code);
  return TYPES.find((t) => t.id === p?.type)?.name ?? code;
}

function fmtHours(s) {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export function renderStats() {
  const rides = storage.allRides().sort((a, b) => b.date.localeCompare(a.date));
  $('data-count').textContent = rides.length
    ? `${rides.length} ride${rides.length === 1 ? '' : 's'} and your settings, in one file.`
    : 'No rides yet, so the file will only hold your settings.';
  if (!rides.length) {
    $('stats-sub').textContent = '';
    $('stats-body').innerHTML = '<p class="muted">No rides yet. Finish a ride and it will show up here.</p>';
    return;
  }
  const sum = (f) => rides.reduce((a, r) => a + f(r), 0);
  const totalS = sum((r) => r.durationS);
  $('stats-sub').textContent = `Since ${new Date(rides.at(-1).date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;

  // Weeks start on Monday.
  const monday = (d) => {
    const m = new Date(d);
    m.setHours(0, 0, 0, 0);
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
    return m;
  };
  const thisWeek = monday(new Date());
  const weeks = Array.from({ length: STATS_WEEKS }, (_, i) => {
    const start = new Date(thisWeek);
    start.setDate(start.getDate() - 7 * (STATS_WEEKS - 1 - i));
    const inWeek = rides.filter((r) => monday(r.date).getTime() === start.getTime());
    return {
      label: start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      minutes: Math.round(inWeek.reduce((a, r) => a + r.durationS, 0) / 60),
      rides: inWeek.length,
    };
  });

  const rows = rides.slice(0, STATS_ROWS).map((r) => `<tr>
    <td>${new Date(r.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
    <td>${esc(rideName(r.code))}</td><td>${Math.round(r.durationS / 60)} min</td><td>${fmtKm(r.distanceM)}</td>
    <td>${Math.round(r.avgPowerW)} W</td><td>${Math.round(r.onTargetPct)}%</td>
    <td><button type="button" class="link" data-delete="${esc(r.id)}">Delete</button></td></tr>`).join('');

  $('stats-body').innerHTML = `
    <div class="stats-tiles">
      <div class="tile"><span class="tile-label">Rides</span><span class="tile-num">${rides.length}</span><span class="tile-sub">${weeks.at(-1).rides} this week</span></div>
      <div class="tile"><span class="tile-label">Time ridden</span><span class="tile-num">${fmtHours(totalS)}</span><span class="tile-sub">${fmtHours(weeks.at(-1).minutes * 60)} this week</span></div>
      <div class="tile"><span class="tile-label">Distance</span><span class="tile-num">${fmtKm(sum((r) => r.distanceM))}</span><span class="tile-sub">virtual, from your power</span></div>
      <div class="tile"><span class="tile-label">On target</span><span class="tile-num">${Math.round(sum((r) => r.onTargetPct * r.durationS) / totalS)}%</span><span class="tile-sub">of ride time, all rides</span></div>
    </div>
    <div class="card stats-card">
      <h2 class="card-title">Minutes each week</h2>
      ${weeksSvg(weeks)}
    </div>
    <div class="card stats-card">
      <h2 class="card-title">${rides.length > STATS_ROWS ? `Last ${STATS_ROWS} rides` : 'Every ride'}</h2>
      <table class="calib-table"><thead><tr><th>Date</th><th>Ride</th><th>Length</th><th>Distance</th><th>Average power</th><th>On target</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
}

$('stats-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-delete]');
  if (!b) return;
  const ride = storage.allRides().find((r) => r.id === b.dataset.delete);
  if (!ride) return;
  const when = new Date(ride.date).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  if (!window.confirm(`Delete the ${rideName(ride.code)} ride from ${when}? This can't be undone.`)) return;
  storage.deleteRide(ride.id);
  renderStats();
});

$('btn-stats').addEventListener('click', () => {
  renderStats();
  showScreen('stats');
});
$('btn-build').addEventListener('click', () => {
  renderSetup();
  showScreen('setup');
});
