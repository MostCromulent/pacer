// Finishing a ride and the summary screen.

import { generateWorkout } from '../core/workout.js';
import { targetWatts } from '../core/ghost.js';
import { rideReview } from '../core/review.js';
import { formatRange } from '../core/cues.js';
import { storage, settings, saveSettings, state, voice } from './store.js';
import { $, toast, showScreen } from './dom.js';
import { fmtClock, fmtKm, fmtGap, fmtDate } from './format.js';
import { rideChartSvg, rideScales, RIDE_PLOT, RIDE_COLORS, esc } from './charts.js';
import { renderSetup, resistanceIsEstimate } from './setup.js';
import { easyResistance } from './pace.js';
import { saveLearning } from './learning.js';
import { startRide, letScreenSleep } from './ride-view.js';
import { calib } from './calibration.js';
import { prefersStill } from './paper.js';

const COUNT_UP_MS = 900;

/** A new best: the distance counts up from nothing, and then the badge stamps down. */
function celebrateBest(distanceM) {
  const badge = $('pb-badge');
  badge.classList.remove('stamped');
  if (prefersStill()) return;
  badge.hidden = true; // until the count is done
  const began = performance.now();
  const tick = (now) => {
    const u = Math.min(1, Math.max(0, (now - began) / COUNT_UP_MS));
    $('t-dist').textContent = fmtKm(distanceM * (1 - (1 - u) ** 3));
    if (u < 1) {
      requestAnimationFrame(tick);
    } else {
      badge.hidden = false;
      badge.classList.add('stamped');
    }
  };
  requestAnimationFrame(tick);
}

/**
 * The planned ride is over. It is saved straight away, so nothing is lost if
 * the rider carries on for a while and then simply closes the window.
 */
export function recordRide(session) {
  if (state.finished) return;
  storage.clearResume();
  const sum = session.summary();
  const ride = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    code: state.ride.workout.code,
    date: new Date().toISOString(),
    durationS: Math.round(sum.durationS),
    distanceM: Math.round(sum.distanceM * 10) / 10,
    avgPowerW: sum.avgPowerW,
    onTargetPct: sum.onTargetPct,
    baselineW: session.baselineW,
    effort: sum.avgEffort,
    climbs: sum.climbs,
    samples: { d: session.samples.d, p: session.samples.p, c: session.samples.c },
  };
  const saved = storage.saveRide(ride);
  if (!saved) toast('Storage is full, so this ride could not be saved. Export your rides to free space.', 7000);
  state.finished = { id: ride.id, sum, saved };
}

/** Leave the ride for its summary. `completed` is false when it is ended before the finish. */
export function finishRide(completed) {
  const s = state.session;
  if (!s) return;
  // The ride is over from here, whatever screen is showing and whatever
  // happens below: nothing more is timed, chimed or spoken.
  state.session = null;
  if (state.pipWin && !state.pipWin.closed) state.pipWin.close();
  storage.clearResume();
  if (completed) recordRide(s);
  const done = state.finished;
  state.finished = null;
  // Time ridden after the finish counts towards the totals, not the race.
  const extra = done && s.extra?.s >= 1 ? { s: Math.round(s.extra.s), m: Math.round(s.extra.dist) } : null;
  if (extra) storage.updateRide(done.id, { extraS: extra.s, extraM: extra.m });
  const { workout, prevBest } = state.ride;
  try {
    renderSummary({ sum: done?.sum ?? s.summary(), workout, prevBest, completed: !!done, saved: !!done?.saved, session: s, extra });
  } catch (err) {
    console.error(err);
    toast('The ride is finished, but its summary could not be drawn.', 6000);
  }
  showScreen('summary');
  letScreenSleep();
  if (!done) voice.stop();
  saveLearning();
}

function renderSummary({ sum, workout, prevBest, completed, saved, session, extra }) {
  const ahead = sum.gap >= 0;
  $('sum-eyebrow').textContent = completed ? 'Ride complete' : 'Ride ended early';
  const who = sum.ghostKind === 'pacer' ? 'the pacer' : 'your ghost';
  $('sum-title').textContent = ahead ? `You beat ${who}.` : `${who === 'the pacer' ? 'The pacer' : 'Your ghost'} got you this time.`;
  const count = storage.ridesFor(workout.code).length;
  $('sum-sub').innerHTML = `${esc(workout.name)} · ${workout.minutes} min · <span style="color:var(--lavender-text)">#${esc(workout.code)}</span>${count ? ` · ridden ${count} time${count === 1 ? '' : 's'}` : ''}${sum.avgEffort !== 1 ? ` · effort ${Math.round(sum.avgEffort * 100)}%` : ''}${extra?.s >= 30 ? ` · then ${fmtClock(extra.s)} more` : ''}`;

  const isPb = completed && saved && (!prevBest || sum.distanceM > prevBest.distanceM);
  $('pb-badge').hidden = !isPb;

  const hero = $('sum-hero');
  hero.classList.toggle('behind', !ahead);
  $('hero-label').textContent = ahead ? `Beat ${who} by` : `${who === 'the pacer' ? 'The pacer' : 'Your ghost'} won by`;
  $('hero-num').textContent = fmtGap(Math.abs(sum.gap)).replace('+', '');
  $('hero-sub').textContent = isPb ? 'This ride is your new PB ghost' : ahead ? 'Nicely done' : 'Race it again to get it back';

  $('t-dist').textContent = fmtKm(sum.distanceM);
  if (isPb) celebrateBest(sum.distanceM);
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

  renderReview(session);

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

/** The chart of the ride and the table of how each block went. */
function renderReview(session) {
  const review = rideReview(session);
  $('ride-chart').innerHTML = rideChartSvg(review);
  $('ride-readout').hidden = true;

  // "on" where the target was held, otherwise how far out it was on average.
  const versus = (d) => (d ? `<small class="miss">${d > 0 ? '+' : '−'}${Math.abs(d)}</small>` : '<small>on</small>');
  $('ride-blocks').innerHTML = `<table class="block-table">
    <thead><tr><th>Block</th><th>On target</th><th>Watts</th><th>Cadence</th><th>Resistance</th></tr></thead>
    <tbody>${review.rows.map((r) => `<tr><td>${esc(r.name)}</td>
      <td><span class="bar"><i class="${r.onTargetPct >= 75 ? 'good' : ''}" style="width:${r.onTargetPct}%"></i></span>${r.onTargetPct}%</td>
      <td>${r.avgW} W</td><td>${r.avgCadence} ${versus(r.cadenceOff)}</td><td>${r.avgResistance} ${versus(r.resistanceOff)}</td></tr>`).join('')}</tbody></table>`;

  // Hover: a line through both panels and a readout of that moment between them.
  const svg = $('ride-chart').querySelector('svg');
  if (!svg) return;
  const { width, height, left, right, split } = RIDE_PLOT;
  const { x, yLevel } = rideScales(review);
  const cursor = svg.querySelector('#ride-cursor'), readout = $('ride-readout');
  const dots = { cadence: svg.querySelector('#ride-dot-cadence'), resistance: svg.querySelector('#ride-dot-resistance') };
  const marks = [cursor, dots.cadence, dots.resistance];
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const sec = Math.min(review.seconds - 1, Math.max(0, Math.floor(((px - left) / (right - left)) * review.seconds)));
    const at = x(sec + 0.5);
    cursor.setAttribute('x1', at);
    cursor.setAttribute('x2', at);
    for (const key of ['cadence', 'resistance']) {
      dots[key].setAttribute('cx', at);
      dots[key].setAttribute('cy', yLevel(review[key][sec]));
    }
    for (const m of marks) m.setAttribute('visibility', 'visible');
    const tg = review.targets[sec];
    const dot = (color) => `<i style="background:${color}"></i>`;
    readout.innerHTML = `<span>${fmtClock(sec)} · ${esc(review.spans[review.spanAt[sec]].name)}</span>
      <span>${dot(RIDE_COLORS.cadence)}Cadence ${review.cadence[sec]} · aim ${tg.cadence}</span>
      <span>${dot('#A99BE0')}Resistance ${review.resistance[sec]} · aim ${tg.resistanceIsExact ? tg.resistance : formatRange(tg.resistanceRange)}</span>
      <span>${dot(RIDE_COLORS.watts)}${review.watts[sec]} W</span>`;
    readout.hidden = false;
    // Centred on the cursor, but kept inside the chart.
    const half = readout.offsetWidth / 2;
    readout.style.top = `${((split + 12) / height) * 100}%`;
    readout.style.left = `${Math.min(box.width - half, Math.max(half, (at / width) * box.width))}px`;
  });
  svg.addEventListener('pointerleave', () => {
    for (const m of marks) m.setAttribute('visibility', 'hidden');
    readout.hidden = true;
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
