import { TYPES, DURATIONS, generateWorkout, parseWorkoutCode, workoutStats } from '../core/workout.js';
import { RideSession, formatRange, stepTargets, spokenCue, DIFFICULTY_MIN, DIFFICULTY_MAX, DIFFICULTY_STEP, SHORT_STEP_S } from '../core/ride.js';
import { pacerGhost, ghostFromRide, targetWatts } from '../core/ghost.js';
import { Storage } from '../core/storage.js';
import { BleBike } from '../core/bike.js';
import { SimulatedBike } from '../core/sim.js';
import { fitModel, crossValidate, resistanceFor, powerFor, CALIBRATION_STEPS } from '../core/resistance.js';
import { Learner, addToBins, fitBins, levelCounts, totalReadings } from '../core/learn.js';
import { Scene } from './scene.js';
import { profileSvg, routeSvg, updateRoute, gapChartSvg, weeksSvg, esc, modelSvg, modelRange, MODEL_PLOT, MODEL_CADENCES } from './charts.js';
import { Chimes, Voice } from './audio.js';
import { popOut, pipSupported } from './pip.js';
import { ZONE_COLORS } from './palette.js';

// Element lookup that also finds elements after the ride panel has moved into
// the picture-in-picture window's document (getElementById only searches one).
let pipDoc = null;
const elCache = new Map();
const $ = (id) => {
  const hit = elCache.get(id);
  if (hit?.isConnected) return hit;
  const found = document.getElementById(id) ?? pipDoc?.getElementById(id) ?? null;
  if (found) elCache.set(id, found);
  return found;
};

const SCENE_HEIGHT = 222;
const ROUTE_W = 328;
const ROUTE_H = 40;

// Dev aids: ?dev shows the simulator, and ?speed=20 also runs the ride clock
// (and simulator) 20x faster.
const QUERY = new URLSearchParams(location.search);
const DEV = QUERY.has('dev') || QUERY.has('speed');
const TIME_SCALE = Math.min(60, Math.max(1, Number(QUERY.get('speed')) || 1));
const clock = () => performance.now() * TIME_SCALE;

const storage = new Storage();
let settings = storage.loadSettings();

// A real bike's calibration lives in the repo (calibration.json, written by the
// dev server), so it survives clearing the browser and travels with the code.
// It holds the model and the pooled readings the model is learned from.
const CALIBRATION_URL = 'calibration.json';
let calibration = null;
try {
  const res = await fetch(CALIBRATION_URL, { cache: 'no-store' });
  const saved = res.ok ? await res.json() : null;
  if (saved?.model?.calibrated) {
    calibration = saved;
    saveSettings({ model: saved.model });
  }
} catch {
  // no saved calibration, or not running under the dev server
}

function binsFrom(samples = []) {
  const bins = {};
  for (const s of samples) addToBins(bins, s);
  return bins;
}

const learner = new Learner(calibration?.bins ?? binsFrom(calibration?.samples));
let learnedSaved = 0;
let lastLearnAt = 0;

async function saveCalibrationFile(patch) {
  calibration = { ...calibration, ...patch };
  try {
    const res = await fetch(CALIBRATION_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calibration),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const chimes = new Chimes();
chimes.muted = settings.muted;
const voice = new Voice();
voice.enabled = settings.voice && !settings.muted;
const scene = new Scene($('scene'), { height: SCENE_HEIGHT });

const state = {
  screen: 'setup',
  step: 0,
  duration: settings.lastDuration,
  type: settings.lastType,
  variant: 0,
  ghostKind: settings.lastGhost,
  workout: null,
  bike: null,
  bikeKind: null,
  bikeState: 'disconnected',
  latest: {},
  session: null,
  started: false,
  paused: false,
  pipWin: null,
  lastAdvance: null,
  lastFrame: null,
  lastDom: 0,
  loopToken: 0,
  advancing: false,
  ride: null,
};

// ---------------------------------------------------------------- helpers

function fmtClock(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fmtKm(m) {
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtGap(m) {
  const a = Math.abs(Math.round(m));
  if (a === 0) return '0 m';
  const sign = m >= 0 ? '+' : '−';
  return a >= 1000 ? `${sign}${(a / 1000).toFixed(2)} km` : `${sign}${a} m`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let toastTimer = null;
function toast(msg, ms = 4200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  storage.saveSettings(settings);
}

function showScreen(name) {
  state.screen = name;
  for (const s of ['setup', 'stats', 'ride', 'summary']) $(`screen-${s}`).hidden = s !== name;
  $('top-nav').hidden = name === 'ride';
  for (const b of document.querySelectorAll('#top-nav [data-screen]')) {
    if (b.dataset.screen === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- setup screen

function currentWorkout() {
  return generateWorkout(state.type, state.duration, state.variant);
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

function pickGhost(workout) {
  const choice = ghostChoices(workout.code).find((g) => g.id === state.ghostKind);
  if (choice?.ride) return ghostFromRide(choice.ride, choice.id);
  // The pacer rides exactly what the screen shows, held-resistance rests included.
  return pacerGhost(workout, settings.baselineW, (seg) => stepTargets(seg, workout.segments, settings.baselineW, settings.model).watts);
}

const TYPE_COLORS = {
  endurance: '#9CC5A1', recovery: '#C3DDC6', tempo: '#F2C14E',
  hills: '#7FB38A', mountain: '#B3A2DD', fartlek: '#F7A1B0',
  intervals: '#F6A96B', hiit: '#F2765C', pyramid: '#E0707F', sprints: '#FFB38A', cadence: '#9DB9F2',
  spinclass: '#B9AEE0', surprise: '#8FD3C6',
};

const SETUP_STEPS = ['Length', 'Type', 'Effort', 'Race'];

const GROUP_COLORS = { Steady: '#9CC5A1', Natural: '#B3A2DD', Intervals: '#F6A96B', Mixed: '#8FD3C6' };

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

function renderSetup() {
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
      <span class="type-group-pick">${list.length} rides</span>
      <span class="type-group-arrow" aria-hidden="true"></span>
    </button>`;
    if (!open) return head;
    return head + list.map((t, i) => `
    <button type="button" class="type${list.length % 2 && i === list.length - 1 ? ' wide' : ''}" data-type="${t.id}" aria-pressed="${t.id === state.type}"
      style="${t.id === state.type ? `border-color:${TYPE_COLORS[t.id]}` : ''}">
      <span class="sw" style="background:${TYPE_COLORS[t.id]}"></span>
      <span><span class="name">${esc(t.name)}</span><span class="hint">${esc(t.hint)}</span></span>
    </button>`).join('');
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
  $('stat-effort').textContent = `${st.effort} / 10`;

  const chosen = choices.find((g) => g.id === state.ghostKind);
  const versus = chosen?.ride ? `${chosen.id === 'pb' ? 'your best' : 'your last ride'} (${fmtKm(chosen.ride.distanceM)})` : 'the pacer';
  $('start-hint').textContent = state.bikeState === 'connected'
    ? `You'll race ${versus}.`
    : '';

  // One step of the setup at a time; each step's tab shows what is picked.
  const picks = [`${w.minutes} min`, w.name, `${Math.round(settings.effort * 100)}%`, { pb: 'Your best', last: 'Last ride' }[state.ghostKind] ?? 'Pacer'];
  $('steps').innerHTML = SETUP_STEPS.map((name, i) => `
    <li><button type="button" class="step" data-go="${i}" ${i === state.step ? 'aria-current="step"' : ''}>
      <span class="step-name">${i + 1} · ${name}</span><span class="step-pick">${esc(picks[i])}</span>
    </button></li>`).join('');
  for (const el of document.querySelectorAll('[data-step]')) el.hidden = Number(el.dataset.step) !== state.step;
  $('step-back').style.visibility = state.step === 0 ? 'hidden' : 'visible';
  $('step-next').style.visibility = state.step === SETUP_STEPS.length - 1 ? 'hidden' : 'visible';
  const banner = needsCalibration() && state.bannerDismissed !== state.bike.name;
  $('calib-banner').hidden = !banner;
  if (banner) {
    const name = state.bike.name;
    $('calib-banner-why').textContent = settings.model.calibrated
      ? `The saved calibration is for ${calibration.bike}. Until ${name} is calibrated, its resistance targets will be off. It takes about two and a half minutes of pedalling.`
      : `${name} hasn't been calibrated, so the resistance targets are a rough guess and probably won't match its screen. It takes about two and a half minutes of pedalling.`;
  }
  $('pace-chip').textContent = `${easyResistance()} resistance at ${settings.easyCadence} rpm`;
  for (const b of document.querySelectorAll('.mode-toggle .seg')) {
    const on = b.dataset.mode === settings.targetMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('calib-nudge').hidden = settings.targetMode !== 'knob' || !knobIsEstimate();
  const sound = settings.muted ? 'off' : settings.voice ? 'voice' : 'chimes';
  for (const b of document.querySelectorAll('#sounds .seg')) {
    b.classList.toggle('on', b.dataset.sound === sound);
    b.setAttribute('aria-pressed', String(b.dataset.sound === sound));
    if (b.dataset.sound === 'voice') b.hidden = !Voice.supported();
  }
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
  $('effort-minus').disabled = settings.effort <= DIFFICULTY_MIN + 1e-9;
  $('effort-plus').disabled = settings.effort >= DIFFICULTY_MAX - 1e-9;
  const steps = w.segments
    .filter((seg) => seg.kind !== 'sprint')
    .map((seg) => stepTargets(seg, w.segments, settings.baselineW * settings.effort, settings.model));
  const easy = steps.reduce((a, b) => (b.watts < a.watts ? b : a));
  const hard = steps.reduce((a, b) => (b.watts > a.watts ? b : a));
  const line = (t) => `resistance ${formatRange(t.knobRange)} at ${formatRange(t.cadenceRange)} rpm (${t.watts} W)`;
  $('effort-note').innerHTML = `Easiest step: ${line(easy)}.<br>Hardest: ${line(hard)}.`;
}

function setEffort(value) {
  const snapped = Math.round(value / DIFFICULTY_STEP) * DIFFICULTY_STEP;
  saveSettings({ effort: Math.round(Math.min(DIFFICULTY_MAX, Math.max(DIFFICULTY_MIN, snapped)) * 100) / 100 });
  renderSetup();
}

$('effort-words').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pct]');
  if (b) setEffort(Number(b.dataset.pct) / 100);
});
$('effort-minus').addEventListener('click', () => setEffort(settings.effort - DIFFICULTY_STEP));
$('effort-plus').addEventListener('click', () => setEffort(settings.effort + DIFFICULTY_STEP));

/** A real bike is connected and there is no calibration for it. */
function needsCalibration() {
  if (state.bikeKind !== 'ble' || state.bikeState !== 'connected') return false;
  return !settings.model.calibrated || !isCalibratedBike();
}

/** Resistance numbers come from the generic model and may not match the bike's screen. */
function knobIsEstimate() {
  return !settings.model.calibrated && state.latest.resistance === undefined;
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
  state.variant = (state.variant + 1) % 3;
  renderSetup();
});

// ---------------------------------------------------------------- easy pace
//
// Rides are scaled from a baseline in watts, which means nothing to most riders.
// So it is set and shown as an easy spin on the bike: a resistance and a cadence.

const EASY_PCT = 0.55; // an easy spin as a share of the baseline, as in recovery steps
const PACE_EXAMPLES = [
  { name: 'Recovery spin', pct: 0.55, cadence: 92 },
  { name: 'Flat road', pct: 0.7, cadence: 88 },
  { name: 'Seated climb', pct: 0.9, cadence: 68 },
  // The same watts ridden two ways: heavy and slow, or light and fast.
  { name: 'Hill climb', pct: 1.05, cadence: 65 },
  { name: 'Downhill sprint', pct: 1.05, cadence: 100 },
];

function baselineFor(resistance, cadence) {
  return Math.min(900, Math.max(60, Math.round(powerFor(settings.model, resistance, cadence) / EASY_PCT)));
}

/** The easy-spin resistance that the current baseline stands for. */
function easyResistance(baselineW = settings.baselineW) {
  return Math.round(resistanceFor(settings.model, baselineW * EASY_PCT, settings.easyCadence));
}

const pace = { resistance: 25, cadence: 80 };

function renderPace() {
  $('pace-r').textContent = String(pace.resistance);
  $('pace-c').textContent = String(pace.cadence);
  const baselineW = baselineFor(pace.resistance, pace.cadence);
  $('pace-rows').innerHTML = PACE_EXAMPLES.map(({ name, pct, cadence }) => {
    const watts = baselineW * pct;
    return `<tr><td>${name}</td><td>resistance ${Math.round(resistanceFor(settings.model, watts, cadence))} at ${cadence} rpm</td><td>${Math.round(watts)} W</td></tr>`;
  }).join('');
  $('pace-note').textContent = settings.model.calibrated
    ? 'The hill climb and the downhill sprint are the same watts: one is heavy and slow, the other light and fast. Watts are as the bike reports them.'
    : "The bike isn't calibrated yet, so these resistances are rough.";
}

$('btn-pace').addEventListener('click', () => {
  pace.resistance = easyResistance();
  pace.cadence = settings.easyCadence;
  renderPace();
  $('pace-dialog').showModal();
});
for (const [id, key, step, lo, hi] of [
  ['pace-r-down', 'resistance', -1, 1, 100], ['pace-r-up', 'resistance', 1, 1, 100],
  ['pace-c-down', 'cadence', -5, 50, 110], ['pace-c-up', 'cadence', 5, 50, 110],
]) {
  $(id).addEventListener('click', () => {
    pace[key] = Math.min(hi, Math.max(lo, pace[key] + step));
    renderPace();
  });
}
$('pace-cancel').addEventListener('click', () => $('pace-dialog').close());
$('pace-save').addEventListener('click', () => {
  saveSettings({ baselineW: baselineFor(pace.resistance, pace.cadence), easyCadence: pace.cadence });
  $('pace-dialog').close();
  renderSetup();
});

$('code-btn').addEventListener('click', () => {
  $('code-input').value = state.workout?.code ?? '';
  $('code-error').hidden = true;
  $('code-dialog').showModal();
});

$('code-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  const parsed = parseWorkoutCode($('code-input').value);
  if (!parsed) {
    e.preventDefault();
    $('code-error').hidden = false;
    return;
  }
  Object.assign(state, { type: parsed.type, duration: parsed.minutes, variant: parsed.variant });
  renderSetup();
});

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([storage.exportAll()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pacer-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const n = storage.importAll(await file.text());
    settings = storage.loadSettings();
    toast(`Imported ${n} ride${n === 1 ? '' : 's'}.`);
    renderSetup();
    renderStats();
  } catch (err) {
    toast(`Couldn't import that file: ${err.message}`);
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- statistics

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

function renderStats() {
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


// ---------------------------------------------------------------- bike connection

function attachBike(bike, kind) {
  detachBike();
  state.bike = bike;
  state.bikeKind = kind;
  state.latest = {};
  bike.addEventListener('data', onReading);
  bike.addEventListener('status', onBikeStatus);
}

function detachBike() {
  if (!state.bike) return;
  state.bike.removeEventListener('data', onReading);
  state.bike.removeEventListener('status', onBikeStatus);
  if (state.bikeKind === 'sim') state.bike.stop();
  else state.bike.disconnect();
  state.bike = null;
  state.bikeKind = null;
  setBikeStatus('disconnected', '');
}

function onBikeStatus(e) {
  setBikeStatus(e.detail.state, e.detail.name);
}

function setBikeStatus(s, name) {
  state.bikeState = s;
  const pill = $('bike-status');
  pill.classList.toggle('ok', s === 'connected');
  pill.classList.toggle('warn', s === 'connecting' || s === 'reconnecting');
  const label = {
    connected: `${name} · connected`,
    connecting: `Connecting to ${name}…`,
    reconnecting: `${name} dropped out · reconnecting…`,
    disconnected: 'No bike connected',
  }[s];
  $('bike-status-text').textContent = label;
  $('btn-sim').textContent = state.bikeKind === 'sim' ? 'Stop simulator' : 'Use simulator';
  $('btn-connect').textContent = state.bikeKind === 'ble' && s !== 'disconnected' ? 'Disconnect' : 'Connect bike';
  $('sim-card').hidden = state.bikeKind !== 'sim';
  if (state.screen === 'setup') renderSetup();
}

$('btn-connect').addEventListener('click', async (e) => {
  if (state.bikeKind === 'ble' && state.bikeState !== 'disconnected') {
    detachBike();
    return;
  }
  if (!BleBike.supported()) {
    toast('Web Bluetooth needs Chrome or Edge on a computer, opened from localhost or https.');
    return;
  }
  const bike = new BleBike();
  attachBike(bike, 'ble');
  try {
    await bike.connect({ showAll: e.shiftKey });
  } catch (err) {
    detachBike();
    if (err?.name === 'NotFoundError') {
      toast('Bike not in the list? Pedal to wake it, close other apps using it, or Shift-click Connect to show every device.', 7000);
    } else {
      toast(`Couldn't connect: ${err?.message || err}`);
    }
  }
});

$('btn-sim').addEventListener('click', () => {
  if (state.bikeKind === 'sim') {
    detachBike();
    return;
  }
  const sim = new SimulatedBike({ reportResistance: settings.simReportsResistance });
  sim.targetProvider = () => {
    const s = state.session;
    if (!s || state.screen !== 'ride') return null;
    const snap = s.snapshot();
    return { seg: snap.seg, targetW: snap.targetW, targetCadence: snap.targetCadence, targetKnob: snap.targetKnob, baselineW: s.baselineW };
  };
  attachBike(sim, 'sim');
  sim.start();
});

function onReading(e) {
  const fields = e.detail;
  state.latest = { ...state.latest, ...fields };
  const s = state.session;
  if (s && state.screen === 'ride') {
    s.setInput({ powerW: fields.powerW, cadence: fields.cadence, resistance: fields.resistance });
    if (!state.started && (fields.cadence ?? 0) > 0 && !state.paused) {
      state.started = true;
      state.lastAdvance = clock();
    }
    // Real-bike notifications keep the ride moving even if no window is drawing.
    if (state.bikeKind === 'ble') advance();
    if (state.started && !state.paused) learnWhileRiding();
  }
  calib.onReading(fields);
}

// ---------------------------------------------------------------- learning the model

/** The saved calibration belongs to one bike; a different bike has to be calibrated first. */
function isCalibratedBike() {
  return !calibration?.bike || calibration.bike === state.bike?.name;
}

/** A bike that reports its resistance measures its own formula on every ride. */
function learnWhileRiding() {
  const l = state.latest;
  if (state.bikeKind !== 'ble' || l.resistance === undefined || !isCalibratedBike()) return;
  const now = performance.now();
  const since = now - lastLearnAt;
  if (since < 900) return; // one reading a second, however the bike splits its packets
  if (since > 3000) learner.rest();
  lastLearnAt = now;
  learner.observe({ resistance: l.resistance, cadence: l.cadence, power: l.powerW });
}

async function saveLearning() {
  const fresh = learner.added - learnedSaved;
  if (!fresh) return;
  const model = fitBins(learner.bins, settings.model);
  if (!model) return;
  learnedSaved = learner.added;
  saveSettings({ model });
  const now = new Date().toISOString();
  const filed = await saveCalibrationFile({
    bike: state.bike?.name ?? calibration?.bike,
    date: calibration?.date ?? now,
    updated: now,
    model,
    bins: learner.bins,
  });
  if (filed) toast(`Bike model updated with ${fresh} readings from this ride.`);
}

// ---------------------------------------------------------------- ride loop

function advance() {
  if (state.advancing) return;
  state.advancing = true;
  try {
    const now = clock();
    const prev = state.lastAdvance ?? now;
    state.lastAdvance = now;
    if (state.bikeKind === 'sim') state.bike.tick(now / 1000);
    const s = state.session;
    if (!s || state.paused || !state.started || s.done) return;
    let left = Math.min((now - prev) / 1000, 10 * TIME_SCALE);
    while (left > 1e-6) {
      const step = Math.min(0.5, left);
      left -= step;
      for (const ev of s.update(step)) onRideEvent(ev);
      if (s.done) break;
    }
  } finally {
    state.advancing = false;
  }
}

function loopWindow() {
  return state.pipWin && !state.pipWin.closed ? state.pipWin : window;
}

function startLoop() {
  const token = ++state.loopToken;
  const win = loopWindow();
  const frame = () => {
    if (token !== state.loopToken) return;
    advance();
    if (state.screen === 'ride' && state.session) renderRide();
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);
}

// Backup tick for when no window is visible to drive animation frames.
setInterval(advance, 1000);

function onRideEvent(ev) {
  if (ev === 'gateEnd') {
    const r = state.session.gateResults.at(-1);
    chimes.play(r?.won ? 'gateWon' : 'gateLost');
  } else if (ev === 'done') {
    chimes.play('done');
    voice.say('Ride complete.');
    setTimeout(() => finishRide(true), 400);
  } else {
    chimes.play(ev);
    if (ev === 'stepChange') {
      const snap = state.session.snapshot();
      voice.say(spokenCue(snap.seg, state.session.targetsFor(snap.seg), settings.targetMode));
    }
  }
}

function startRide(workout) {
  if (state.bikeState !== 'connected') {
    toast('Connect your bike first.');
    return;
  }
  chimes.unlock();
  state.workout = workout;
  const ghost = pickGhost(workout);
  state.session = new RideSession({ workout, baselineW: settings.baselineW, model: settings.model, ghost });
  state.session.setDifficulty(settings.effort);
  state.started = false;
  state.paused = false;
  state.lastAdvance = clock();
  state.ride = { workout, ghost, prevBest: storage.bestRide(workout.code), prevLast: storage.lastRide(workout.code) };
  // Hills follow resistance: steeper means turn it up. Measured against an easy
  // cruise at the starting effort, so raising the effort makes the hills grow.
  state.terrainRef = state.session.targetsFor({ kind: 'steady', pct: 70, cadence: 88 }).knob;
  applyTerrain();
  $('route-label').textContent = `Route · ${workout.name} ${workout.minutes} min`;
  $('pip-note').textContent = pipSupported() ? '' : 'Floating windows need Chrome or Edge 116+. You can still snap this window beside your show.';
  $('btn-pip-big').disabled = !pipSupported();
  $('btn-pip').disabled = !pipSupported();
  updatePauseButton();
  showScreen('ride');
  state.lastDom = 0;
  // Rides open in the mini window. The browser only allows that straight from
  // a click, which starting a ride always is.
  holdScreenAwake();
  if (pipSupported() && !(state.pipWin && !state.pipWin.closed)) togglePip();
}

function applyTerrain() {
  const s = state.session;
  if (!s) return;
  const ref = state.terrainRef;
  scene.setWorkout(s.workout, (seg) => Math.tanh((s.targetsFor(seg).knob - ref) / 10));
  state.routeHeight = (seg) => (s.targetsFor(seg).knob - 15) / 70;
  $('route-svg').innerHTML = routeSvg(s.workout, ROUTE_W, ROUTE_H, state.routeHeight);
}

$('btn-start').addEventListener('click', () => startRide(currentWorkout()));

function renderRide() {
  const s = state.session;
  const now = performance.now();
  const dt = state.lastFrame ? Math.min(0.1, (now - state.lastFrame) / 1000) : 0.016;
  state.lastFrame = now;
  const snap = s.snapshot();
  const animSnap = state.started && !state.paused ? snap : { ...snap, cadence: 0, speed: 0, ghostSpeed: 0, ghostCadence: 0 };
  scene.render(animSnap, state.started && !state.paused ? dt : 0);

  if (now - state.lastDom < 200) return;
  state.lastDom = now;

  $('time-left').textContent = fmtClock(snap.totalS - snap.t);
  $('total-bar').style.width = `${Math.min(100, (snap.t / snap.totalS) * 100).toFixed(1)}%`;

  const gp = $('gap-pill');
  gp.classList.remove('ahead', 'behind', 'gate');
  if (!state.started) {
    gp.textContent = 'Ready';
    gp.dataset.word = '';
  } else if (snap.gate) {
    gp.classList.add('gate');
    gp.textContent = fmtGap(snap.gate.you - snap.gate.ghost);
    gp.dataset.word = 'in gate';
  } else {
    gp.classList.add(snap.gap >= 0 ? 'ahead' : 'behind');
    gp.textContent = fmtGap(snap.gap);
    gp.dataset.word = snap.gap >= 0 ? 'ahead' : 'behind';
  }
  const np = $('next-pill');
  if (snap.gate) np.textContent = `Gate ${snap.gate.index + 1}/${snap.gate.count} · ${fmtClock(snap.gate.left)}`;
  else if (snap.nextGate && snap.nextGate.inS < 600) np.textContent = `Gate ${snap.nextGate.index + 1} in ${fmtClock(snap.nextGate.inS)}`;
  else np.textContent = '';

  const zc = $('zone-chip');
  if (snap.seg.kind === 'sprint') {
    zc.textContent = 'GO';
    zc.style.background = '#F2765C';
  } else {
    zc.textContent = `Z${snap.zone}`;
    zc.style.background = ZONE_COLORS[snap.zone];
  }
  const seg = snap.seg;
  const next = s.workout.segments[snap.segIndex + 1];
  $('step-label').textContent = seg.label;
  $('next-label').textContent = next ? `Next: ${shortLabel(next)}` : 'Last step';
  $('step-time').textContent = fmtClock(snap.stepLeft);
  $('step-bar').style.width = `${Math.min(100, (1 - snap.stepLeft / seg.dur) * 100).toFixed(1)}%`;
  $('countdown').classList.toggle('soon', state.started && !state.paused && !!next && seg.dur >= SHORT_STEP_S && snap.stepLeft <= 10);

  const live = state.started && !snap.noSignal;
  const sprint = seg.kind === 'sprint';
  const estimate = knobIsEstimate();
  const resNow = snap.resistance === null ? '–' : String(snap.resistance);
  const cadenceTile = {
    label: 'Cadence',
    aim: formatRange(snap.cadenceRange),
    now: String(snap.cadence),
    status: live ? snap.cadenceStatus : '',
  };
  if (settings.targetMode === 'watts') {
    setTile('a', {
      label: 'Watts',
      aim: sprint ? 'all out' : formatRange(snap.wattsRange),
      now: String(snap.powerW),
      status: live ? (snap.onTarget ? 'on' : sprint || snap.powerW < snap.targetW ? 'low' : 'high') : '',
    });
    setTile('b', cadenceTile);
    $('aside-line').textContent = `Res ${estimate ? '≈' : ''}${formatRange(snap.knobRange)} · now ${resNow}`;
  } else {
    setTile('a', cadenceTile);
    setTile('b', {
      label: estimate ? 'Resistance · est.' : 'Resistance',
      aim: formatRange(snap.knobRange),
      now: resNow,
      status: live ? snap.knobStatus : '',
    });
    $('aside-line').textContent = sprint ? `Now ${snap.powerW} W` : `${snap.targetW} W · now ${snap.powerW}`;
  }
  const dv = $('diff-val');
  const pct = Math.round(snap.difficulty * 100);
  dv.textContent = `${pct}%`;
  dv.classList.toggle('up', pct > 100);
  dv.classList.toggle('down', pct < 100);
  $('diff-down').disabled = snap.difficulty <= DIFFICULTY_MIN + 1e-9;
  $('diff-up').disabled = snap.difficulty >= DIFFICULTY_MAX - 1e-9;

  updateRoute($('ride-panel'), s.workout, snap.t, ROUTE_W, ROUTE_H, state.routeHeight);
  $('route-dist').textContent = fmtKm(snap.dist);

  const ov = $('overlay');
  let msg = '';
  if (state.paused) msg = 'Paused';
  else if (!state.started) msg = 'Start pedalling to begin';
  else if (snap.noSignal) msg = state.bikeState === 'reconnecting' ? 'Bike dropped out · reconnecting…' : 'Waiting for the bike… keep pedalling';
  ov.hidden = !msg;
  $('overlay-text').textContent = msg;

  if (state.bikeKind === 'sim') {
    $('sim-cad').textContent = Math.round(state.bike.cadence);
    $('sim-knob').textContent = Math.round(state.bike.resistance);
  }
}

function shortLabel(seg) {
  return seg.label.replace(/ of \d+$/, '');
}

// A tile leads with what the rider is doing; its colour says whether that is
// in range, and an arrow says which way to go when it isn't.
const TILE_HOLD_MS = 2500;
const tileShown = {};

function setTile(key, { label, aim, now, status }) {
  $(`tile-${key}-lbl`).textContent = label;
  // A big number that flickers with every pedal stroke is hard to read, so it
  // holds for a couple of seconds, unless it has just moved in or out of range.
  const shown = (tileShown[key] ??= {});
  const at = performance.now();
  if (shown.status !== status || shown.aim !== aim || at - (shown.at ?? 0) >= TILE_HOLD_MS) {
    $(`tile-${key}-now`).textContent = now;
    Object.assign(shown, { status, aim, at });
  }
  $(`tile-${key}-arrow`).textContent = { low: '↑', high: '↓' }[status] ?? '';
  $(`tile-${key}-aim`).textContent = aim;
  $(`tile-${key}`).className = `num-col ${status || ''}`;
}

function updatePauseButton() {
  $('btn-pause').setAttribute('aria-label', state.paused ? 'Resume' : 'Pause');
  $('pause-icon').innerHTML = state.paused ? '<path d="M7 4.5v15l12-7.5z"/>' : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
}

$('btn-pause').addEventListener('click', () => {
  if (!state.session) return;
  state.paused = !state.paused;
  state.lastAdvance = clock();
  updatePauseButton();
  state.lastDom = 0;
});

function setSound({ muted = settings.muted, voice: spoken = settings.voice }) {
  saveSettings({ muted, voice: spoken });
  chimes.muted = muted;
  voice.enabled = spoken && !muted;
  if (!voice.enabled) voice.stop();
  updateMute();
}

$('btn-mute').addEventListener('click', () => setSound({ muted: !settings.muted }));

$('sounds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sound]');
  if (!b) return;
  const kind = b.dataset.sound;
  chimes.unlock();
  setSound({ muted: kind === 'off', voice: kind === 'voice' });
  if (kind === 'voice') voice.say('Voice cues on.');
  if (kind === 'chimes') chimes.play('stepChange');
  renderSetup();
});

function updateMute() {
  $('btn-mute').setAttribute('aria-pressed', String(chimes.muted));
  $('btn-mute').setAttribute('aria-label', chimes.muted ? 'Unmute sound' : 'Mute sound');
  $('mute-wave').style.display = chimes.muted ? 'none' : '';
}

$('btn-end').addEventListener('click', () => {
  if (!state.session) return;
  if (!state.session.done && !window.confirm('End the ride now? Rides that end early are not saved as ghosts.')) return;
  finishRide(state.session.done);
});

// Keep the screen awake for the length of a ride. The lock belongs to a
// visible window, so it is taken from the mini window when that is open.
let wakeLock = null;

async function holdScreenAwake() {
  const win = state.pipWin && !state.pipWin.closed ? state.pipWin : window;
  try {
    await wakeLock?.release();
    wakeLock = (await win.navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null; // not supported, or the window isn't visible
  }
}

function letScreenSleep() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// The browser drops the lock when a window is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.screen === 'ride') holdScreenAwake();
});

// Picture-in-picture
async function togglePip() {
  if (state.pipWin && !state.pipWin.closed) {
    state.pipWin.close();
    return;
  }
  try {
    const win = await popOut($('ride-panel'), {
      width: 400,
      height: 720,
      onClose: () => {
        state.pipWin = null;
        pipDoc = null;
        $('ride-panel').style.transform = '';
        scene.pixelScale = 1;
        $('panel-home').classList.remove('away');
        startLoop();
        if (state.screen === 'ride') holdScreenAwake();
      },
    });
    state.pipWin = win;
    pipDoc = win.document;
    win.addEventListener('keydown', onKey);
    win.addEventListener('resize', fitPip);
    fitPip();
    $('panel-home').classList.add('away');
    startLoop();
    holdScreenAwake();
  } catch (err) {
    toast(err.message || String(err));
  }
}
// Scale the panel to fill the floating window, so dragging it bigger makes the numbers bigger.
function fitPip() {
  const win = state.pipWin;
  if (!win || win.closed) return;
  const k = Math.max(0.5, Math.min(win.innerWidth / 400, win.innerHeight / 720));
  $('ride-panel').style.transform = `scale(${k})`;
  scene.pixelScale = k;
}

$('btn-pip').addEventListener('click', togglePip);
$('btn-pip-big').addEventListener('click', togglePip);

// Simulator controls
function simNudge(kind, d) {
  if (state.bikeKind !== 'sim') return;
  if (kind === 'cad') state.bike.nudgeCadence(d);
  else state.bike.nudgeKnob(d);
  setSimMode('manual');
}

function setSimMode(mode) {
  if (state.bikeKind !== 'sim') return;
  if (state.bike.mode !== mode) state.bike.setMode(mode);
  $('sim-auto').classList.toggle('on', mode === 'auto');
  $('sim-manual').classList.toggle('on', mode === 'manual');
  $('sim-auto').setAttribute('aria-pressed', String(mode === 'auto'));
  $('sim-manual').setAttribute('aria-pressed', String(mode === 'manual'));
}

$('sim-auto').addEventListener('click', () => setSimMode('auto'));
$('sim-manual').addEventListener('click', () => setSimMode('manual'));
$('cad-up').addEventListener('click', () => simNudge('cad', 5));
$('cad-down').addEventListener('click', () => simNudge('cad', -5));
$('knob-up').addEventListener('click', () => simNudge('knob', 2));
$('knob-down').addEventListener('click', () => simNudge('knob', -2));

function nudgeEffort(steps) {
  const s = state.session;
  if (!s || state.screen !== 'ride') return;
  const before = s.difficulty;
  if (s.nudgeDifficulty(steps) === before) return;
  const dv = $('diff-val');
  dv.classList.remove('flash');
  void dv.offsetWidth; // restart the animation
  dv.classList.add('flash');
  applyTerrain();
  state.lastDom = 0;
}

$('diff-down').addEventListener('click', () => nudgeEffort(-1));
$('diff-up').addEventListener('click', () => nudgeEffort(+1));

function onKey(e) {
  if (e.target?.closest?.('input, textarea, select')) return;
  if (state.screen !== 'ride') return;
  if (e.key === '-' || e.key === '_') { e.preventDefault(); nudgeEffort(-1); return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); nudgeEffort(+1); return; }
  if (state.bikeKind !== 'sim') return;
  const map = { ArrowUp: ['cad', 5], ArrowDown: ['cad', -5], ArrowRight: ['knob', 2], ArrowLeft: ['knob', -2] };
  const m = map[e.key];
  if (!m) return;
  e.preventDefault();
  simNudge(m[0], m[1]);
}
window.addEventListener('keydown', onKey);

// ---------------------------------------------------------------- summary

function finishRide(completed) {
  const s = state.session;
  if (!s || state.screen !== 'ride') return;
  if (state.pipWin && !state.pipWin.closed) state.pipWin.close();
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
      difficulty: sum.avgDifficulty,
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
  $('sum-sub').innerHTML = `${esc(workout.name)} · ${workout.minutes} min · <span style="color:var(--lavender-text)">#${esc(workout.code)}</span>${count ? ` · ridden ${count} time${count === 1 ? '' : 's'}` : ''}${sum.avgDifficulty !== 1 ? ` · effort ${Math.round(sum.avgDifficulty * 100)}%` : ''}`;

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
        : `resistance ${c.avgKnob ?? '–'} · ${c.avgCadence} rpm`;
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
    const followRatio = ratio / sum.avgDifficulty;
    const effortPct = Math.round(sum.avgDifficulty * 100);
    if ((followRatio > 1.04 || followRatio < 0.9) && settings.targetMode === 'knob' && knobIsEstimate()) {
      // Following estimated knob numbers: the gap is most likely the estimate, not fitness.
      $('baseline-tip-text').textContent = `Following the resistance targets, your hard efforts came out ${Math.round(Math.abs(followRatio - 1) * 100)}% ${followRatio > 1 ? 'above' : 'below'} target. Calibrate so the resistance numbers match your bike.`;
      $('btn-apply-baseline').textContent = 'Calibrate resistance';
      tip.hidden = false;
      $('btn-apply-baseline').onclick = () => {
        tip.hidden = true;
        calib.start();
      };
    } else if (ratio > 1.04 || ratio < 0.9) {
      $('btn-apply-baseline').textContent = ratio > 1 ? 'Make rides harder' : 'Make rides easier';
      const cap = Math.max(0.08, Math.abs(sum.avgDifficulty - 1) + 0.02);
      const suggested = Math.round((session.baselineW * Math.min(1 + cap, Math.max(1 - cap, ratio))) / 5) * 5;
      if (suggested !== session.baselineW) {
        const changedEffort = Math.abs(sum.avgDifficulty - 1) >= 0.03;
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
    const knobs = xs.map((x) => x.avgKnob).filter((x) => x !== null && x !== undefined);
    return {
      label: `${k} ×${xs.length}`,
      avgW: avg(xs.map((x) => x.avgW)),
      avgCadence: avg(xs.map((x) => x.avgCadence)),
      avgKnob: knobs.length ? avg(knobs) : null,
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
  startRide(generateWorkout(w.type, w.minutes, w.variant));
});

$('btn-new').addEventListener('click', () => {
  renderSetup();
  showScreen('setup');
});

// ---------------------------------------------------------------- calibration

const STEPS = CALIBRATION_STEPS;
const SETTLE_S = 5;
const RECORD_S = 10;
const CADENCE_TOL = 8; // rpm either side of the step's cadence that counts as on target
const MIN_READINGS = 5;
const STALE_MS = 2000; // no packet for this long means the rider has stopped
const round1 = (x) => Math.round(x * 10) / 10;

const calib = {
  open: false,
  phase: 'intro',
  level: 0,
  started: null, // when the rider first reached the step's cadence
  recordedS: 0,
  lastTick: 0,
  lastReading: 0,
  samples: [],
  levelSamples: [],
  model: null,
  check: null,
  timer: null,

  start() {
    if (state.bikeState !== 'connected') {
      toast('Connect a bike first.');
      return;
    }
    this.open = true;
    this.phase = 'intro';
    this.samples = [];
    this.model = null;
    this.check = null;
    this.render();
    $('calib').showModal();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
  },

  close() {
    this.open = false;
    clearInterval(this.timer);
    if (state.bikeKind === 'sim') setSimMode('auto');
    $('calib').close();
  },

  beginLevel(i) {
    this.phase = 'level';
    this.level = i;
    this.started = null;
    this.recordedS = 0;
    this.lastTick = performance.now();
    this.levelSamples = [];
    if (state.bikeKind === 'sim') {
      // Stand-in for the rider setting resistance and cadence.
      setSimMode('manual');
      state.bike.manualResistance = STEPS[i].resistance;
      state.bike.manualCadence = STEPS[i].cadence;
    }
    this.render();
  },

  // Pedalling at the step's cadence, going by the latest packets from the bike.
  onTarget() {
    const l = state.latest;
    return performance.now() - this.lastReading < STALE_MS
      && l.powerW > 0
      && Math.abs((l.cadence ?? 0) - STEPS[this.level].cadence) <= CADENCE_TOL;
  },

  settled() {
    return this.started !== null && (performance.now() - this.started) / 1000 >= SETTLE_S;
  },

  onReading() {
    if (!this.open || this.phase !== 'level') return;
    this.lastReading = performance.now();
    // A bike may split one reading over several packets, so read the merged latest.
    if (this.settled() && this.onTarget()) {
      // Trust the bike's own resistance reading when it agrees with the step, in
      // case the knob is a level out; ignore it if it's on some other scale.
      const asked = STEPS[this.level].resistance;
      const reported = state.latest.resistance;
      const resistance = Math.abs(reported - asked) <= 5 ? reported : asked;
      this.levelSamples.push({ resistance, cadence: state.latest.cadence, power: state.latest.powerW });
    }
  },

  tick() {
    if (!this.open) return;
    if (this.phase === 'level') {
      const now = performance.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      // The step's clock only starts once the rider is up to cadence, and the
      // recording only counts time spent there, so every level gets its full share.
      if (this.started === null) {
        if (this.onTarget()) this.started = now;
      } else if (this.settled() && this.onTarget()) {
        this.recordedS += dt;
      }
      if (this.recordedS >= RECORD_S && this.levelSamples.length >= MIN_READINGS) {
        this.samples.push(...this.levelSamples);
        this.nextLevel();
        return;
      }
    }
    this.renderLive();
  },

  nextLevel() {
    if (this.level + 1 < STEPS.length) this.beginLevel(this.level + 1);
    else this.finish();
  },

  finish() {
    this.phase = 'result';
    this.model = fitModel(this.samples, settings.model);
    this.check = this.model ? crossValidate(this.samples, settings.model) : null;
    if (state.bikeKind === 'sim') setSimMode('auto');
    this.render();
  },

  render() {
    const body = $('calib-body');
    const next = $('calib-next');
    const skip = $('calib-skip');
    skip.hidden = this.phase !== 'level';
    next.hidden = false;
    if (this.phase === 'intro') {
      body.innerHTML = `
        <p>You'll ride ${STEPS.length} short steps. Each one gives you a resistance and a cadence.</p>
        <p>Set the resistance by the number on the bike's screen, then pedal up to the cadence. Recording starts when you get there and takes ${RECORD_S} seconds. If you drift off the cadence, it pauses until you're back.</p>
        <p class="muted">About two and a half minutes of pedalling in total. Two of the resistances come up twice, once slow and once fast.</p>`;
      next.textContent = 'Begin';
    } else if (this.phase === 'level') {
      const st = STEPS[this.level];
      body.innerHTML = `
        <p class="muted small">Step ${this.level + 1} of ${STEPS.length}</p>
        <div class="calib-ask">
          <div><span class="calib-ask-lbl">Resistance</span><span class="knob-big">${st.resistance}</span></div>
          <div><span class="calib-ask-lbl">Cadence</span><span class="knob-big">${st.cadence}<small> rpm</small></span></div>
        </div>
        <p id="calib-phase" class="muted">Waiting for you to reach the cadence</p>
        <div class="calib-progress"><i id="calib-bar"></i></div>
        <div class="calib-live">
          <div id="cl-c-box" class="stat"><span id="cl-c" class="stat-num">0</span><span class="stat-label">Cadence now</span></div>
          <div class="stat"><span id="cl-r" class="stat-num">–</span><span class="stat-label">Resistance now</span></div>
          <div class="stat"><span id="cl-p" class="stat-num">0 W</span><span class="stat-label">Power</span></div>
        </div>`;
      next.hidden = true;
    } else {
      if (!this.model) {
        body.innerHTML = `<p class="error">Not enough readings to work with. Try again, and stay on each cadence until the step finishes.</p>`;
        next.textContent = 'Try again';
        return;
      }
      const cv = this.check;
      const rows = (cv?.results ?? []).map((x) => `<tr><td>Resistance ${x.level}</td><td>${Math.round(x.cadence)} rpm</td><td>${round1(x.predicted)}</td></tr>`).join('');
      const shaky = cv && cv.interiorMaxAbs > 2;
      body.innerHTML = `
        ${cv
          ? `<p>Done. Resistance targets should now be within about <b>±${round1(Math.max(0.5, cv.interiorMeanAbs))} levels</b> of the bike's screen. The worst step was out by ${round1(cv.maxAbs)}.</p>`
          : '<p>Done.</p>'}
        ${shaky ? '<p class="error small">A few steps were uneven. Run it again and hold each cadence steadier for a tighter result.</p>' : ''}
        <p class="muted small">Each step was left out in turn and predicted from the others:</p>
        <table class="calib-table"><thead><tr><th>Step</th><th>Cadence</th><th>Predicted</th></tr></thead><tbody>${rows}</tbody></table>
        <p>To check it, set any resistance and pedal. The app makes it <b id="calib-detect">—</b>.</p>`;
      next.textContent = 'Save';
    }
  },

  renderLive() {
    const l = state.latest;
    if (this.phase === 'level') {
      const bar = $('calib-bar');
      if (!bar) return;
      const want = STEPS[this.level].cadence;
      const cad = Math.round(l.cadence ?? 0);
      const off = cad - want;
      const settleS = this.started === null ? 0 : Math.min(SETTLE_S, (performance.now() - this.started) / 1000);
      bar.style.width = `${Math.min(100, ((settleS + this.recordedS) / (SETTLE_S + RECORD_S)) * 100)}%`;
      const left = Math.max(1, Math.ceil(RECORD_S - this.recordedS));
      $('calib-phase').textContent = this.started === null
        ? 'Waiting for you to reach the cadence'
        : !this.settled() ? 'Hold it there…'
          : this.onTarget() ? `Recording · ${left}s left` : `Paused · pedal ${off < 0 ? 'faster' : 'slower'}`;
      $('cl-r').textContent = l.resistance === undefined ? '–' : String(Math.round(l.resistance));
      $('cl-c').textContent = String(cad);
      $('cl-c-box').className = `stat ${cad > 0 ? (Math.abs(off) <= CADENCE_TOL ? 'good' : 'off') : ''}`;
      $('cl-p').textContent = `${Math.round(l.powerW ?? 0)} W`;
    } else if (this.phase === 'result' && this.model) {
      const el = $('calib-detect');
      if (el && l.powerW > 5 && l.cadence > 20) el.textContent = String(Math.round(resistanceFor(this.model, l.powerW, l.cadence)));
    }
  },
};

$('btn-calibrate-nudge').addEventListener('click', () => calib.start());
$('calib-cancel').addEventListener('click', () => calib.close());
$('calib-skip').addEventListener('click', () => calib.nextLevel());
$('calib').addEventListener('cancel', () => calib.close());
$('calib-next').addEventListener('click', async () => {
  if (calib.phase === 'intro') calib.beginLevel(0);
  else if (calib.phase === 'result') {
    if (calib.model) {
      // The simulator's formula is made up, so only a real bike is written to the repo.
      if (state.bikeKind === 'ble') {
        // Recalibrating the same bike adds to what it has already learned.
        if (!isCalibratedBike()) learner.bins = {};
        for (const s of calib.samples) addToBins(learner.bins, s);
        const model = fitBins(learner.bins, settings.model) ?? calib.model;
        saveSettings({ model });
        const now = new Date().toISOString();
        const filed = await saveCalibrationFile({
          bike: state.bike.name,
          date: now,
          updated: now,
          model,
          check: calib.check,
          samples: calib.samples,
          bins: learner.bins,
        });
        toast(filed ? 'Calibration saved.' : "Calibration saved in this browser, but calibration.json couldn't be written.");
      } else {
        saveSettings({ model: calib.model });
        toast('Calibration saved.');
      }
      calib.close();
      renderSetup();
    } else {
      calib.samples = [];
      calib.beginLevel(0);
    }
  }
});

$('btn-calibrate-banner').addEventListener('click', () => calib.start());
$('calib-banner-later').addEventListener('click', () => {
  state.bannerDismissed = state.bike?.name;
  renderSetup();
});

// ---------------------------------------------------------------- bike model

function renderModel() {
  const model = settings.model;
  const { lo, hi, from, to } = modelRange(model);
  const counts = levelCounts(learner.bins);
  const readings = totalReadings(learner.bins);
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const about = model.calibrated
    ? [calibration?.bike, calibration?.date && `calibrated ${day(calibration.date)}`, calibration?.updated && `last updated ${day(calibration.updated)}`].filter(Boolean).map(esc).join(' · ')
    : 'Not calibrated yet. This is the generic curve the app uses until you calibrate.';

  // One row per measured level while there are only a few, then every five levels.
  const few = model.knots && model.knots.length <= 12;
  const levels = few ? model.knots.map(([r]) => r) : [];
  if (!few) for (let r = Math.ceil(lo / 5) * 5; r <= hi; r += 5) levels.push(r);
  const near = (r) => (few ? counts[r] ?? 0 : [-2, -1, 0, 1, 2].reduce((n, d) => n + (counts[r + d] ?? 0), 0));
  const rows = levels.map((r) => `<tr class="${r < from || r > to ? 'est' : ''}"><td>${r}</td>${MODEL_CADENCES.map(({ rpm }) => `<td>${Math.round(powerFor(model, r, rpm))} W</td>`).join('')}<td>${model.knots ? near(r) : '–'}</td></tr>`).join('');

  const cv = calibration?.check;
  $('model-body').innerHTML = `
    <p class="muted small">${about}</p>
    <div class="model-chart">
      <div class="model-legend">
        <span>Watts at each resistance</span>
        <span class="legend">${MODEL_CADENCES.map(({ rpm, color }) => `<span><i class="sw" style="background:${color}"></i>${rpm} rpm</span>`).join('')}</span>
      </div>
      ${modelSvg(model)}
      <div id="model-tip" class="model-tip" hidden></div>
    </div>
    <div class="model-facts">
      <div class="stat"><span class="stat-num">${model.knots ? `${from}–${to}` : '–'}</span><span class="stat-label">Levels measured</span></div>
      <div class="stat"><span class="stat-num">+${Math.round((1.1 ** model.b - 1) * 100)}%</span><span class="stat-label">Watts for 10% more cadence</span></div>
      <div class="stat"><span class="stat-num">${cv ? `±${round1(Math.max(0.5, cv.interiorMeanAbs))}` : '–'}</span><span class="stat-label">Resistance margin of error</span></div>
    </div>
    <div class="model-table-wrap">
      <table class="calib-table"><thead><tr><th>Resistance</th>${MODEL_CADENCES.map(({ rpm }) => `<th>${rpm} rpm</th>`).join('')}<th>Readings</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <p class="muted small">${model.knots
      ? `Built from ${readings} readings. Dashed lines and grey rows are beyond the levels measured so far. If the bike reports its resistance, the model is updated after every ride.`
      : 'Calibrate to replace this with measurements from your bike.'}</p>`;
  $('model-calibrate').textContent = model.calibrated ? 'Calibrate again' : 'Calibrate';

  // Hover: a crosshair and the watts at that resistance for each cadence.
  const svg = $('model-svg');
  const cross = $('model-cross');
  const tip = $('model-tip');
  const { width, left, right } = MODEL_PLOT;
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const r = Math.round(Math.min(hi, Math.max(lo, lo + ((px - left) / (width - left - right)) * (hi - lo))));
    const x = left + ((r - lo) / (hi - lo)) * (width - left - right);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `Resistance ${r}<br>${[...MODEL_CADENCES].reverse().map(({ rpm, color }) => `<i style="background:${color}"></i>${rpm} rpm · ${Math.round(powerFor(model, r, rpm))} W`).join('<br>')}`;
    tip.hidden = false;
    const frac = x / width;
    tip.style.left = frac < 0.55 ? `calc(${frac * 100}% + 18px)` : 'auto';
    tip.style.right = frac < 0.55 ? 'auto' : `calc(${(1 - frac) * 100}% + 18px)`;
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

$('btn-model').addEventListener('click', () => {
  renderModel();
  $('model-dialog').showModal();
});
$('model-close').addEventListener('click', () => $('model-dialog').close());
$('model-calibrate').addEventListener('click', () => {
  $('model-dialog').close();
  calib.start();
});

// ---------------------------------------------------------------- go

updateMute();
renderSetup();
showScreen('setup');
startLoop();

// Expose a tiny hook for automated checks and debugging in the console.
window.pacer = { state, settings: () => settings, storage };
