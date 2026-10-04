// Finishing a ride and the summary screen.

import { generateWorkout } from '../core/workout.js';
import { targetWatts } from '../core/ghost.js';
import { storage, settings, saveSettings, state, voice } from './store.js';
import { $, toast, showScreen } from './dom.js';
import { fmtClock, fmtKm, fmtGap, fmtDate } from './format.js';
import { gapChartSvg, esc } from './charts.js';
import { renderSetup, resistanceIsEstimate } from './setup.js';
import { easyResistance } from './pace.js';
import { saveLearning } from './learning.js';
import { startRide, letScreenSleep } from './ride-view.js';
import { calib } from './calibration.js';

export function finishRide(completed) {
  const s = state.session;
  if (!s || state.screen !== 'ride') return;
  if (state.pipWin && !state.pipWin.closed) state.pipWin.close();
  storage.clearResume();
  const sum = s.summary();
  const { workout, prevBest, prevLast } = state.ride;

  let saved = false;
  if (completed) {
    const ride = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      code: workout.code,
      date: new Date().toISOString(),
      durationS: Math.round(sum.durationS),
      distanceM: Math.round(sum.distanceM * 10) / 10,
      avgPowerW: sum.avgPowerW,
      onTargetPct: sum.onTargetPct,
      baselineW: s.baselineW,
      effort: sum.avgEffort,
      climbs: sum.climbs,
      samples: { d: s.samples.d, p: s.samples.p, c: s.samples.c },
    };
    saved = storage.saveRide(ride);
    if (!saved) toast('Storage is full, so this ride could not be saved. Export your rides to free space.', 7000);
  }
  renderSummary({ sum, workout, prevBest, prevLast, completed, saved, session: s });
  state.session = null;
  showScreen('summary');
  letScreenSleep();
  if (!completed) voice.stop();
  saveLearning();
}

function renderSummary({ sum, workout, prevBest, prevLast, completed, saved, session }) {
  const ahead = sum.gap >= 0;
  $('sum-eyebrow').textContent = completed ? 'Ride complete' : 'Ride ended early';
  const who = sum.ghostKind === 'pacer' ? 'the pacer' : 'your ghost';
  $('sum-title').textContent = ahead ? `You beat ${who}.` : `${who === 'the pacer' ? 'The pacer' : 'Your ghost'} got you this time.`;
  const count = storage.ridesFor(workout.code).length;
  $('sum-sub').innerHTML = `${esc(workout.name)} · ${workout.minutes} min · <span style="color:var(--lavender-text)">#${esc(workout.code)}</span>${count ? ` · ridden ${count} time${count === 1 ? '' : 's'}` : ''}${sum.avgEffort !== 1 ? ` · effort ${Math.round(sum.avgEffort * 100)}%` : ''}`;

  const isPb = completed && saved && (!prevBest || sum.distanceM > prevBest.distanceM);
  $('pb-badge').hidden = !isPb;

  const hero = $('sum-hero');
  hero.classList.toggle('behind', !ahead);
  $('hero-label').textContent = ahead ? `Beat ${who} by` : `${who === 'the pacer' ? 'The pacer' : 'Your ghost'} won by`;
  $('hero-num').textContent = fmtGap(Math.abs(sum.gap)).replace('+', '');
  $('hero-sub').textContent = isPb ? 'This ride is your new PB ghost' : ahead ? 'Nicely done' : 'Race it again to get it back';

  $('t-dist').textContent = fmtKm(sum.distanceM);
  const dSub = $('t-dist-sub');
  if (prevBest) {
    const diff = sum.distanceM - prevBest.distanceM;
    dSub.textContent = `${diff >= 0 ? '+' : '−'}${Math.abs(diff / 1000).toFixed(2)} km vs best`;
    dSub.classList.toggle('good', diff >= 0);
  } else {
    dSub.textContent = 'First time on this workout';
    dSub.classList.remove('good');
  }
  $('t-on').textContent = `${sum.onTargetPct}%`;
  $('t-on-sub').textContent = `${fmtClock(sum.onTargetS)} of ${fmtClock(sum.durationS)}`;
  $('t-pow').textContent = `${sum.avgPowerW} W`;
  $('t-pow-sub').textContent = `${sum.avgCadence} rpm average`;
  const won = sum.gates.filter((g) => g.won).length;
  if (!workout.gates.length) {
    $('t-gates').textContent = '—';
    $('t-gates-sub').textContent = 'No gates in this workout';
  } else if (!sum.gates.length) {
    $('t-gates').textContent = '0';
    $('t-gates-sub').textContent = 'Ended before the first gate finished';
  } else {
    $('t-gates').textContent = `${won} of ${sum.gates.length}`;
    $('t-gates-sub').textContent = sum.gates.length < workout.gates.length
      ? `won · ${workout.gates.length - sum.gates.length} not reached`
      : 'won against the ghost';
  }

  $('gap-chart').innerHTML = gapChartSvg(sum.gapPerMinute);
  $('sum-axis-end').textContent = `${Math.floor(sum.durationS / 60)} min`;

  // Lots of short efforts (HIIT, fartlek): one row per kind of effort.
  const many = sum.climbs.length > 8;
  const climbs = many ? groupEfforts(sum.climbs) : sum.climbs;
  const prevClimbs = many ? groupEfforts(prevLast?.climbs ?? []) : prevLast?.climbs ?? [];
  $('climbs').innerHTML = climbs.length
    ? climbs.map((c, i) => {
      const p = prevClimbs[i];
      const d = p ? c.avgW - p.avgW : null;
      const cls = d === null ? '' : d >= 0 ? 'up' : 'down';
      const txt = d === null ? 'new' : `${d >= 0 ? '+' : '−'}${Math.abs(d)} W`;
      const metric = settings.targetMode === 'watts'
        ? `${c.avgW} W`
        : `resistance ${c.avgResistance ?? '–'} · ${c.avgCadence} rpm`;
      return `<div class="climb"><span>${esc(many ? c.label : c.label.replace(/ of \d+$/, ''))}</span><span class="muted">${metric}</span>
        <span class="bar"><i style="width:${c.onTargetPct}%"></i></span><span class="muted">${c.onTargetPct}%</span>
        <span class="delta ${cls}">${txt}</span></div>`;
    }).join('')
    : '<p class="muted">This workout has no hard efforts to compare.</p>';

  const rides = storage.ridesFor(workout.code).slice(-6);
  const max = Math.max(1, ...rides.map((r) => r.distanceM), sum.distanceM);
  const rows = rides.map((r, i) => ({ when: fmtDate(r.date), km: r.distanceM, today: saved && i === rides.length - 1 }));
  if (!saved) rows.push({ when: 'Today', km: sum.distanceM, today: true });
  $('history').innerHTML = rows.map((r) => `
    <div class="hist-row${r.today ? ' today' : ''}"><span>${esc(r.when)}</span>
      <span class="bar"><i style="width:${Math.round((r.km / max) * 96)}%"></i></span><span class="km">${fmtKm(r.km)}</span></div>`).join('');
  $('history-note').textContent = !completed
    ? 'This ride ended early, so it was not saved as a ghost.'
    : isPb ? "Next time you'll race today's ride." : 'Your best ride is still the ghost to beat.';

  // Suggest a baseline change when the hard efforts were clearly too easy or too hard.
  const work = session.workout.segments
    .map((seg, i) => ({ seg, st: session.segOnTarget[i] }))
    .filter(({ seg, st }) => seg.kind === 'work' && st.total > 30);
  const tip = $('baseline-tip');
  tip.hidden = true;
  if (completed && work.length) {
    const actual = work.reduce((a, { st }) => a + st.powerSum, 0) / work.reduce((a, { st }) => a + st.total, 0);
    const target = work.reduce((a, { seg, st }) => a + targetWatts(seg, session.baselineW) * st.total, 0) / work.reduce((a, { st }) => a + st.total, 0);
    const ratio = actual / target;
    // How closely the watts matched what was on screen (targets include the effort setting).
    const followRatio = ratio / sum.avgEffort;
    const effortPct = Math.round(sum.avgEffort * 100);
    if ((followRatio > 1.04 || followRatio < 0.9) && settings.targetMode === 'resistance' && resistanceIsEstimate()) {
      // Following estimated resistance numbers: the gap is most likely the estimate, not fitness.
      $('baseline-tip-text').textContent = `Following the resistance targets, your hard efforts came out ${Math.round(Math.abs(followRatio - 1) * 100)}% ${followRatio > 1 ? 'above' : 'below'} target. Calibrate so the resistance numbers match your bike.`;
      $('btn-apply-baseline').textContent = 'Calibrate resistance';
      tip.hidden = false;
      $('btn-apply-baseline').onclick = () => {
        tip.hidden = true;
        calib.start();
      };
    } else if (ratio > 1.04 || ratio < 0.9) {
      $('btn-apply-baseline').textContent = ratio > 1 ? 'Make rides harder' : 'Make rides easier';
      const cap = Math.max(0.08, Math.abs(sum.avgEffort - 1) + 0.02);
      const suggested = Math.round((session.baselineW * Math.min(1 + cap, Math.max(1 - cap, ratio))) / 5) * 5;
      if (suggested !== session.baselineW) {
        const changedEffort = Math.abs(sum.avgEffort - 1) >= 0.03;
        $('baseline-tip-text').textContent = ratio > 1
          ? changedEffort
            ? `You turned the effort up to ${effortPct}% and held it. Make that your normal?`
            : `You rode the hard efforts ${Math.round((ratio - 1) * 100)}% above target. Make rides harder from now on?`
          : changedEffort
            ? `You eased the effort to ${effortPct}% today. Make that your normal?`
            : `The hard efforts were tough today (${Math.round((1 - ratio) * 100)}% under target). Make rides easier from now on?`;
        tip.hidden = false;
        $('btn-apply-baseline').onclick = () => {
          saveSettings({ baselineW: suggested, effort: 1 });
          tip.hidden = true;
          toast(`Your easy pace is now ${easyResistance(suggested)} resistance at ${settings.easyCadence} rpm.`);
        };
      }
    }
  }
}

function effortKind(label) {
  return label.replace(/·.*$/, '').replace(/\bof\b/g, '').replace(/[\d/]+/g, '').replace(/\s+/g, ' ').trim();
}

function groupEfforts(list) {
  const groups = new Map();
  for (const c of list) {
    const k = effortKind(c.label);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return [...groups.entries()].map(([k, xs]) => {
    const resistances = xs.map((x) => x.avgResistance).filter((x) => x !== null && x !== undefined);
    return {
      label: `${k} ×${xs.length}`,
      avgW: avg(xs.map((x) => x.avgW)),
      avgCadence: avg(xs.map((x) => x.avgCadence)),
      avgResistance: resistances.length ? avg(resistances) : null,
      onTargetPct: avg(xs.map((x) => x.onTargetPct)),
    };
  });
}

$('btn-again').addEventListener('click', () => {
  const w = state.ride?.workout;
  if (!w) return;
  state.type = w.type;
  state.duration = w.minutes;
  state.variant = w.variant;
  state.ghostKind = 'pb';
  saveSettings({ lastGhost: 'pb' });
  startRide(generateWorkout(w.type, w.minutes, w.variant, w.options));
});

$('btn-new').addEventListener('click', () => {
  renderSetup();
  showScreen('setup');
});
