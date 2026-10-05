// Finishing a ride and the summary screen.

import { generateWorkout } from '../core/workout.js';
import { targetWatts } from '../core/ghost.js';
import { rideReview, rideVerdict } from '../core/review.js';
import { formatRange } from '../core/cues.js';
import { storage, settings, saveSettings, state, voice } from './store.js';
import { $, toast, showScreen } from './dom.js';
import { fmtClock, fmtKm, fmtGap } from './format.js';
import { rideChartSvg, rideScales, RIDE_PLOT, RIDE_COLORS, esc } from './charts.js';
import { renderSetup, resistanceIsEstimate } from './setup.js';
import { easyResistance } from './pace.js';
import { saveLearning } from './learning.js';
import { startRide, letScreenSleep } from './ride-view.js';
import { calib } from './calibration.js';
import { prefersStill } from './paper.js';

const COUNT_UP_MS = 900;

/** A new best: its distance counts up in the headline, and lands with a stamp. */
function celebrateBest(distanceM) {
  const figure = $('sum-gap');
  figure.classList.remove('stamped');
  if (prefersStill()) return;
  const began = performance.now();
  const tick = (now) => {
    const u = Math.min(1, Math.max(0, (now - began) / COUNT_UP_MS));
    figure.textContent = fmtKm(distanceM * (1 - (1 - u) ** 3));
    if (u < 1) requestAnimationFrame(tick);
    else figure.classList.add('stamped');
  };
  requestAnimationFrame(tick);
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

/** "12.3, 12.7 and 17.7 km" */
function listKm(metres) {
  const km = metres.map((m) => (m / 1000).toFixed(1));
  return `${km.length > 1 ? `${km.slice(0, -1).join(', ')} and ` : ''}${km.at(-1)} km`;
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
  const Who = sum.ghostKind === 'pacer' ? 'The pacer' : 'Your ghost';
  const gap = fmtGap(Math.abs(sum.gap)).replace('+', '');
  const isPb = completed && saved && (!prevBest || sum.distanceM > prevBest.distanceM);
  // The headline is the best news there is: a new best if it was one, otherwise the race.
  const figure = $('sum-gap');
  figure.classList.toggle('best', isPb);
  figure.classList.toggle('behind', !isPb && !ahead);
  $('sum-title').textContent = isPb ? 'New best:' : ahead ? `You beat ${who} by` : `${Who} got you by`;
  figure.textContent = isPb ? fmtKm(sum.distanceM) : gap;
  const race = ahead ? `You beat ${who} by ${gap}` : `${Who} finished ${gap} ahead`;
  $('sum-sub').innerHTML = `${isPb ? `${race} · ` : ''}${esc(workout.name)} · ${workout.minutes} min · <span style="color:var(--lavender-text)">#${esc(workout.code)}</span>${sum.avgEffort !== 1 ? ` · effort ${Math.round(sum.avgEffort * 100)}%` : ''}${extra?.s >= 30 ? ` · then ${fmtClock(extra.s)} more` : ''}`;

  // History in a line: how many times, how far each time, and who the ghost is next.
  const before = storage.ridesFor(workout.code).slice(-5).map((r) => r.distanceM);
  const times = storage.ridesFor(workout.code).length + (saved ? 0 : 1);
  const distances = saved ? before : [...before, sum.distanceM].slice(-5);
  const nth = `${ORDINALS[times - 1] ?? `Ride ${times},`}${ORDINALS[times - 1] ? ' time' : ''} on this ride`;
  const next = !completed ? 'It ended early, so it was not saved as a ghost.' : isPb ? "Next time you'll race today's ride." : 'Your best ride is still the ghost to beat.';
  $('sum-history').textContent = `${nth}${times > 1 ? `: ${listKm(distances)}` : ''}. ${next}`;

  // The ride's figures, as chips beside the headline.
  const diff = prevBest ? sum.distanceM - prevBest.distanceM : null;
  const count = sum.gates.length;
  const vsBest = diff === null ? '' : `<small class="${diff >= 0 ? 'good' : ''}">${diff >= 0 ? '+' : '−'}${Math.abs(diff / 1000).toFixed(2)} km vs best</small>`;
  const won = sum.gates.filter((g) => g.won).length;
  const chips = [
    `Distance<b>${fmtKm(sum.distanceM)}</b>${vsBest}`,
    `On target<b>${sum.onTargetPct}%</b>`,
    `Average power<b>${sum.avgPowerW} W</b><small>${sum.avgCadence} rpm</small>`,
    // Each sprint is a short race of its own against the ghost; they only count once one has been ridden.
    count ? `Sprints won<b>${won} of ${count}</b>` : '',
  ];
  $('sum-chips').innerHTML = chips.filter(Boolean).map((c) => `<span class="sum-chip">${c}</span>`).join('');
  if (isPb) celebrateBest(sum.distanceM);

  renderReview(session);

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
      $('baseline-tip-title').textContent = 'Calibrate this bike?';
      tip.hidden = false;
      $('btn-apply-baseline').onclick = () => {
        tip.hidden = true;
        calib.start();
      };
    } else if (ratio > 1.04 || ratio < 0.9) {
      $('btn-apply-baseline').textContent = ratio > 1 ? 'Make rides harder' : 'Make rides easier';
      $('baseline-tip-title').textContent = ratio > 1 ? 'Make rides harder?' : 'Make rides easier?';
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

  $('ride-verdict').textContent = rideVerdict(review);

  // A figure alone where the target was held; where it wasn't, how far out it was on average.
  const held = (value, off) => `${value}${off ? `<small>${off > 0 ? '+' : '−'}${Math.abs(off)}</small>` : ''}`;
  $('ride-blocks').innerHTML = `<table class="block-table">
    <thead><tr><th>Block</th><th>On target</th><th>Watts</th><th>Cadence</th><th>Resistance</th></tr></thead>
    <tbody>${review.rows.map((r) => `<tr data-block="${esc(r.name.replace(/ ×\d+$/, ''))}"><td>${esc(r.name)}</td>
      ${r.rest ? '<td class="none">–</td>' : `<td class="${r.onTargetPct >= 75 ? '' : 'low'}">${r.onTargetPct}%</td>`}
      <td>${r.avgW} W</td><td>${held(r.avgCadence, r.rest ? 0 : r.cadenceOff)}</td><td>${held(r.avgResistance, r.rest ? 0 : r.resistanceOff)}</td></tr>`).join('')}</tbody></table>`;

  // Pointing at a block's name over the chart, or at its line in the table, picks out the other.
  const lightUp = (name) => {
    for (const el of document.querySelectorAll('#ride-chart g[data-block], #ride-blocks tr[data-block]')) el.classList.toggle('lit', el.dataset.block === name);
  };
  for (const id of ['ride-chart', 'ride-blocks']) {
    $(id).onpointerover = (e) => lightUp(e.target.closest('[data-block]')?.dataset.block ?? null);
    $(id).onpointerleave = () => lightUp(null);
  }

  // Hover: a line down the plot, and a readout of that moment under it, over the key.
  const svg = $('ride-chart').querySelector('svg');
  if (!svg) return;
  const { width, height, left, right, base } = RIDE_PLOT;
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
    readout.style.top = `${((base + 43) / height) * 100}%`;
    readout.style.left = `${Math.min(box.width - half, Math.max(half, (at / width) * box.width))}px`;
  });
  svg.addEventListener('pointerleave', () => {
    for (const m of marks) m.setAttribute('visibility', 'hidden');
    readout.hidden = true;
  });
}

$('baseline-tip-later').addEventListener('click', () => { $('baseline-tip').hidden = true; });

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
