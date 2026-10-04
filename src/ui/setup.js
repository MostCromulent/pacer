// Build a ride: the four setup steps, the ride preview and the workout code.

import { TYPES, DURATIONS, SPIN_BLOCKS, generateWorkout, workoutStats, randomVariant } from '../core/workout.js';
import { stepTargets, EFFORT_MIN, EFFORT_MAX, EFFORT_STEP } from '../core/ride.js';
import { formatRange } from '../core/cues.js';
import { pacerGhost, ghostFromRide } from '../core/ghost.js';
import { DEV, storage, settings, saveSettings, calibration, activeModel, state } from './store.js';
import { $, toast } from './dom.js';
import { Voice } from './audio.js';
import { fmtKm, fmtDate } from './format.js';
import { profileSvg, esc } from './charts.js';
import { ZONE_COLORS } from './palette.js';
import { easyResistance } from './pace.js';
import { isCalibratedBike } from './learning.js';

export function currentWorkout() {
  return generateWorkout(state.type, state.duration, state.variant, { exclude: settings.spinExclude });
}

function ghostChoices(code) {
  const best = storage.bestRide(code);
  const last = storage.lastRide(code);
  return [
    { id: 'pb', name: 'Your best on this ride', sub: best ? fmtKm(best.distanceM) : 'No rides yet', ride: best },
    { id: 'last', name: 'Your last ride', sub: last ? `${fmtKm(last.distanceM)} · ${fmtDate(last.date)}` : 'No rides yet', ride: last },
    { id: 'pacer', name: 'Pacer', sub: 'Hits every target exactly' },
  ];
}

export function pickGhost(workout) {
  const choice = ghostChoices(workout.code).find((g) => g.id === state.ghostKind);
  if (choice?.ride) return ghostFromRide(choice.ride, choice.id);
  // The pacer rides exactly what the screen shows, held-resistance rests included.
  return pacerGhost(workout, settings.baselineW, (seg) => stepTargets(seg, workout.segments, settings.baselineW, activeModel()).watts);
}

const TYPE_COLORS = {
  endurance: '#9CC5A1', recovery: '#C3DDC6', lowimpact: '#A9D3D0', sweetspot: '#F2C14E', progression: '#F0B35A',
  hills: '#7FB38A', mountain: '#B3A2DD', fartlek: '#F7A1B0',
  intervals: '#F6A96B', climbs: '#C9A27E', hiit: '#F2765C', pyramid: '#E0707F', sprints: '#FFB38A', cadence: '#9DB9F2',
  spinclass: '#B9AEE0', spinlow: '#D9CFF2', mix: '#8FD3C6',
};

const SETUP_STEPS = ['Length', 'Type', 'Effort', 'Race'];

const GROUP_COLORS = { Steady: '#9CC5A1', Natural: '#B3A2DD', Intervals: '#F6A96B', 'Spin class': '#F7A1B0', Mixed: '#8FD3C6' };

// Effort can be picked by word or set exactly. Each word covers a band of
// percentages (up to `max`) and picking it sets `pct`.
const EFFORT_WORDS = [
  { word: 'Very easy', pct: 60, max: 65 },
  { word: 'Easy', pct: 80, max: 90 },
  { word: 'Normal', pct: 100, max: 105 },
  { word: 'Hard', pct: 120, max: 130 },
  { word: 'Very hard', pct: 140, max: Infinity },
];

function effortWord(effort) {
  const pct = Math.round(effort * 100);
  return EFFORT_WORDS.find((w) => pct <= w.max).word;
}

export function renderSetup() {
  const w = currentWorkout();
  state.workout = w;

  $('durations').innerHTML = DURATIONS.map((d) => `
    <button type="button" class="dur" data-min="${d.min}" aria-pressed="${d.min === state.duration}">
      <span class="num">${d.min}</span><span class="lbl">${esc(d.label)}</span>
    </button>`).join('');
  const custom = !DURATIONS.some((d) => d.min === state.duration);
  $('custom-dur').classList.toggle('on', custom);
  if (document.activeElement !== $('cust-min')) $('cust-min').value = state.duration;

  // One group of types open at a time; a closed group shows the pick inside it.
  const groups = [...new Set(TYPES.map((t) => t.group))];
  if (state.typeGroup === undefined) state.typeGroup = TYPES.find((t) => t.id === state.type)?.group;
  $('types').innerHTML = `<button type="button" class="type-random" data-random>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
      Pick one for me
    </button>` + groups.map((g) => {
    const list = TYPES.filter((t) => t.group === g);
    const open = g === state.typeGroup;
    const head = `<button type="button" class="type-group" data-group="${esc(g)}" aria-expanded="${open}" style="background:${GROUP_COLORS[g] ?? ''}">
      <span>${esc(g)}</span>
      <span class="type-group-pick">${list.length} ride${list.length === 1 ? '' : 's'}</span>
      <span class="type-group-arrow" aria-hidden="true"></span>
    </button>`;
    if (!open) return head;
    // An open group is one shaded box in the group's colour, holding its rides.
    return `<div class="type-open" style="--group:${GROUP_COLORS[g] ?? ''}">${head}<div class="type-list">` + list.map((t, i) => `
    <button type="button" class="type${(list.length % 2 && i === list.length - 1) || list.some((x) => x.blocks) ? ' wide' : ''}" data-type="${t.id}" aria-pressed="${t.id === state.type}"
      style="${t.id === state.type ? `border-color:${TYPE_COLORS[t.id]}` : ''}">
      <span class="sw" style="background:${TYPE_COLORS[t.id]}"></span>
      <span><span class="name">${esc(t.name)}</span><span class="hint">${esc(t.hint)}</span></span>
      ${t.blocks ? `<span class="type-new" role="button" tabindex="0" data-new-class title="Make a new random class" aria-label="Make a new random class">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
        New class</span>` : ''}
    </button>`).join('') + (list.some((x) => x.blocks) ? spinBlockChips() : '') + '</div></div>';
  }).join('');

  const choices = ghostChoices(w.code);
  $('ghosts').innerHTML = choices.map((g) => `
    <button type="button" class="ghost-opt" data-ghost="${g.id}" aria-pressed="${g.id === state.ghostKind}">
      <span class="name">${esc(g.name)}</span><span class="sub">${esc(g.sub)}</span>
    </button>`).join('');

  $('preview-title').textContent = `${w.name} · ${w.minutes} min`;
  $('preview-code').textContent = `#${w.code}`;
  $('preview-chart').innerHTML = profileSvg(w, 600, 196, settings.effort);
  $('axis-mid').textContent = String(Math.round(w.minutes / 2));
  $('axis-end').textContent = `${w.minutes} min`;
  $('zones').innerHTML = [['Z1 recover', 1], ['Z2 endurance', 2], ['Z3 tempo', 3], ['Z4 threshold', 4], ['Z5 max', 5]]
    .map(([n, z]) => `<span><i style="background:${ZONE_COLORS[z]}"></i>${n}</span>`).join('');
  const st = workoutStats(w, settings.baselineW, settings.effort);
  renderEffort(w);
  $('stat-hard').textContent = `${st.hardMinutes} min`;
  $('stat-avg').textContent = `${st.avgTargetW} W`;
  $('stat-effort').textContent = `${st.score} / 10`;

  const chosen = choices.find((g) => g.id === state.ghostKind);
  const versus = chosen?.ride ? `${chosen.id === 'pb' ? 'your best' : 'your last ride'} (${fmtKm(chosen.ride.distanceM)})` : 'the pacer';
  $('start-hint').textContent = state.bikeState === 'connected'
    ? `You'll race ${versus}.`
    : '';

  // One step of the setup at a time; each step's tab shows what is picked.
  const picks = [`${w.minutes} min`, w.name, `${Math.round(settings.effort * 100)}%`, { pb: 'Your best', last: 'Last ride' }[state.ghostKind] ?? 'Pacer'];
  $('steps').innerHTML = SETUP_STEPS.map((name, i) => `
    <li><button type="button" class="step" data-go="${i}" ${i === state.step ? 'aria-current="step"' : ''}>
      <span class="step-num" aria-hidden="true">${i + 1}</span>
      <span class="step-name"><span class="sr-only">Step ${i + 1}: </span>${name}</span><span class="step-pick">${esc(picks[i])}</span>
    </button></li>`).join('');
  for (const el of document.querySelectorAll('[data-step]')) el.hidden = Number(el.dataset.step) !== state.step;
  $('step-back').style.visibility = state.step === 0 ? 'hidden' : 'visible';
  $('step-next').style.visibility = state.step === SETUP_STEPS.length - 1 ? 'hidden' : 'visible';
  const banner = needsCalibration() && state.bannerDismissed !== state.bike.name;
  $('calib-banner').hidden = !banner;
  if (banner) {
    const name = state.bike.name;
    $('calib-banner-why').textContent = activeModel().calibrated
      ? `The saved calibration is for ${calibration.bike}. Until ${name} is calibrated, its resistance targets will be off. It takes about two and a half minutes of pedalling.`
      : `${name} hasn't been calibrated, so the resistance targets are a rough guess and probably won't match its screen. It takes about two and a half minutes of pedalling.`;
  }
  $('pace-chip').textContent = `${easyResistance()} resistance at ${settings.easyCadence} rpm`;
  for (const b of document.querySelectorAll('.mode-toggle .seg')) {
    const on = b.dataset.mode === settings.targetMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('calib-nudge').hidden = settings.targetMode !== 'resistance' || !resistanceIsEstimate();
  const sound = settings.muted ? 'off' : settings.voice ? 'voice' : 'chimes';
  for (const b of document.querySelectorAll('#sounds .seg')) {
    b.classList.toggle('on', b.dataset.sound === sound);
    b.setAttribute('aria-pressed', String(b.dataset.sound === sound));
    if (b.dataset.sound === 'voice') b.hidden = !Voice.supported();
  }
}

/** Chips to leave blocks out of a spin class. The low impact class only has the gentle ones. */
function spinBlockChips() {
  const low = state.type === 'spinlow';
  const chips = SPIN_BLOCKS.filter((b) => !b.always).map((b) => {
    const off = low && !b.gentle;
    const on = !off && !settings.spinExclude.includes(b.id);
    return `<button type="button" class="chip-toggle" data-block="${b.id}" aria-pressed="${on}" ${off ? 'disabled' : ''}>${esc(b.title)}</button>`;
  }).join('');
  return `<div class="block-chips"><span class="block-chips-title">Blocks in the class · tap to leave one out</span>${chips}</div>`;
}

function goToStep(i) {
  state.step = Math.min(SETUP_STEPS.length - 1, Math.max(0, i));
  renderSetup();
}

$('steps').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) goToStep(Number(b.dataset.go));
});
$('step-back').addEventListener('click', () => goToStep(state.step - 1));
$('step-next').addEventListener('click', () => goToStep(state.step + 1));
$('btn-sim').hidden = !DEV;

/** The effort the ride starts at, and what it means on the bike for this workout. */
function renderEffort(w) {
  $('effort-val').textContent = `${Math.round(settings.effort * 100)}%`;
  const word = effortWord(settings.effort);
  $('effort-words').innerHTML = EFFORT_WORDS.map((w) => `<button type="button" class="seg${w.word === word ? ' on' : ''}" data-pct="${w.pct}" aria-pressed="${w.word === word}">${w.word}</button>`).join('');
  $('effort-minus').disabled = settings.effort <= EFFORT_MIN + 1e-9;
  $('effort-plus').disabled = settings.effort >= EFFORT_MAX - 1e-9;
  const steps = w.segments
    .filter((seg) => seg.kind !== 'sprint')
    .map((seg) => stepTargets(seg, w.segments, settings.baselineW * settings.effort, activeModel()));
  const easy = steps.reduce((a, b) => (b.watts < a.watts ? b : a));
  const hard = steps.reduce((a, b) => (b.watts > a.watts ? b : a));
  const line = (t) => `resistance ${formatRange(t.resistanceRange)} at ${formatRange(t.cadenceRange)} rpm (${t.watts} W)`;
  $('effort-note').innerHTML = `Easiest step: ${line(easy)}.<br>Hardest: ${line(hard)}.`;
}

function setEffort(value) {
  const snapped = Math.round(value / EFFORT_STEP) * EFFORT_STEP;
  saveSettings({ effort: Math.round(Math.min(EFFORT_MAX, Math.max(EFFORT_MIN, snapped)) * 100) / 100 });
  renderSetup();
}

$('effort-words').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pct]');
  if (b) setEffort(Number(b.dataset.pct) / 100);
});
$('effort-minus').addEventListener('click', () => setEffort(settings.effort - EFFORT_STEP));
$('effort-plus').addEventListener('click', () => setEffort(settings.effort + EFFORT_STEP));

/** A real bike is connected and there is no calibration for it. */
function needsCalibration() {
  if (state.bikeKind !== 'ble' || state.bikeState !== 'connected') return false;
  return !activeModel().calibrated || !isCalibratedBike();
}

/** Resistance numbers come from the generic model and may not match the bike's screen. */
export function resistanceIsEstimate() {
  return !activeModel().calibrated && state.latest.resistance === undefined;
}

for (const b of document.querySelectorAll('.mode-toggle .seg')) {
  b.addEventListener('click', () => {
    saveSettings({ targetMode: b.dataset.mode });
    renderSetup();
  });
}

const MIN_MINUTES = 10;
const MAX_MINUTES = 120;

function setDuration(minutes) {
  state.duration = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(minutes)));
  state.variant = 0;
  saveSettings({ lastDuration: state.duration });
  renderSetup();
}

$('durations').addEventListener('click', (e) => {
  const b = e.target.closest('[data-min]');
  if (b) setDuration(Number(b.dataset.min));
});

$('cust-min').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v) || v <= 0) {
    e.target.value = state.duration;
    return;
  }
  if (v < MIN_MINUTES || v > MAX_MINUTES) toast(`Rides can be ${MIN_MINUTES} to ${MAX_MINUTES} minutes.`);
  e.target.blur();
  setDuration(v);
});
$('cust-minus').addEventListener('click', () => setDuration(Math.ceil(state.duration / 5) * 5 - 5));
$('cust-plus').addEventListener('click', () => setDuration(Math.floor(state.duration / 5) * 5 + 5));

$('types').addEventListener('click', (e) => {
  if (e.target.closest('[data-random]')) {
    // Any ride but the current one, in any of its three versions.
    const others = TYPES.filter((t) => t.id !== state.type);
    const pick = others[Math.floor(Math.random() * others.length)];
    state.type = pick.id;
    state.variant = Math.floor(Math.random() * 3);
    state.typeGroup = pick.group;
    saveSettings({ lastType: state.type });
    renderSetup();
    return;
  }
  const chip = e.target.closest('[data-block]');
  if (chip) {
    const id = chip.dataset.block;
    const out = settings.spinExclude.includes(id);
    saveSettings({ spinExclude: out ? settings.spinExclude.filter((x) => x !== id) : [...settings.spinExclude, id] });
    renderSetup();
    return;
  }
  if (e.target.closest('[data-new-class]')) {
    // A fresh random class: blocks in a new order, with new numbers.
    state.type = e.target.closest('[data-type]').dataset.type;
    state.variant = randomVariant();
    saveSettings({ lastType: state.type });
    renderSetup();
    return;
  }
  const head = e.target.closest('[data-group]');
  if (head) {
    state.typeGroup = state.typeGroup === head.dataset.group ? null : head.dataset.group;
    renderSetup();
    return;
  }
  const b = e.target.closest('[data-type]');
  if (!b) return;
  state.type = b.dataset.type;
  state.variant = 0;
  saveSettings({ lastType: state.type });
  renderSetup();
});

$('ghosts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ghost]');
  if (!b) return;
  state.ghostKind = b.dataset.ghost;
  saveSettings({ lastGhost: state.ghostKind });
  renderSetup();
});

$('btn-shuffle').addEventListener('click', () => {
  state.variant = state.variant >= 3 ? 0 : (state.variant + 1) % 3;
  renderSetup();
});
