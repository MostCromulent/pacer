import { TYPES, DURATIONS, generateWorkout, parseWorkoutCode, workoutStats } from '../core/workout.js';
import { RideSession, formatRange } from '../core/ride.js';
import { pacerGhost, ghostFromRide, targetWatts } from '../core/ghost.js';
import { Storage } from '../core/storage.js';
import { BleBike } from '../core/bike.js';
import { SimulatedBike } from '../core/sim.js';
import { fitModel, modelError, powerFor, resistanceFor } from '../core/resistance.js';
import { Scene } from './scene.js';
import { profileSvg, routeSvg, updateRoute, gapChartSvg, esc } from './charts.js';
import { Chimes } from './audio.js';
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

const SCENE_HEIGHT = 236;
const ROUTE_W = 328;
const ROUTE_H = 40;

// Dev aid: ?speed=20 runs the ride clock (and simulator) 20x faster.
const TIME_SCALE = Math.min(60, Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1));
const clock = () => performance.now() * TIME_SCALE;

const storage = new Storage();
let settings = storage.loadSettings();
const chimes = new Chimes();
chimes.muted = settings.muted;
const scene = new Scene($('scene'), { height: SCENE_HEIGHT });

const state = {
  screen: 'setup',
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
  for (const s of ['setup', 'ride', 'summary']) $(`screen-${s}`).hidden = s !== name;
  window.scrollTo(0, 0);
}

const ICONS = {
  up: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
  down: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>',
  ok: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  gate: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
};

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
  return pacerGhost(workout, settings.baselineW);
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

  const typeColors = { endurance: '#9CC5A1', tempo: '#F2C14E', intervals: '#F6A96B', pyramid: '#E0707F', sprints: '#F2765C', cadence: '#9DB9F2', surprise: '#B9AEE0' };
  $('types').innerHTML = TYPES.map((t) => `
    <button type="button" class="type${t.id === 'surprise' ? ' wide' : ''}" data-type="${t.id}" aria-pressed="${t.id === state.type}"
      style="${t.id === state.type ? `border-color:${typeColors[t.id]}` : ''}">
      <span class="sw" style="background:${typeColors[t.id]}"></span>
      <span><span class="name">${esc(t.name)}</span><span class="hint">${esc(t.hint)}</span></span>
    </button>`).join('');

  const choices = ghostChoices(w.code);
  $('ghosts').innerHTML = choices.map((g) => `
    <button type="button" class="ghost-opt" data-ghost="${g.id}" aria-pressed="${g.id === state.ghostKind}">
      <span class="name">${esc(g.name)}</span><span class="sub">${esc(g.sub)}</span>
    </button>`).join('');

  $('preview-title').textContent = `${w.name} · ${w.minutes} min`;
  $('preview-code').textContent = `#${w.code}`;
  $('preview-chart').innerHTML = profileSvg(w, 600, 196);
  $('axis-mid').textContent = String(Math.round(w.minutes / 2));
  $('axis-end').textContent = `${w.minutes} min`;
  $('zones').innerHTML = [['Z1 recover', 1], ['Z2 endurance', 2], ['Z3 tempo', 3], ['Z4 threshold', 4], ['Z5 max', 5]]
    .map(([n, z]) => `<span><i style="background:${ZONE_COLORS[z]}"></i>${n}</span>`).join('');
  const st = workoutStats(w, settings.baselineW);
  $('stat-hard').textContent = `${st.hardMinutes} min`;
  $('stat-avg').textContent = `${st.avgTargetW} W`;
  $('stat-effort').textContent = `${st.effort} / 10`;

  const chosen = choices.find((g) => g.id === state.ghostKind);
  const versus = chosen?.ride ? `${chosen.id === 'pb' ? 'your best' : 'your last ride'} (${fmtKm(chosen.ride.distanceM)})` : 'the pacer';
  $('start-hint').textContent = state.bikeState === 'connected'
    ? `You'll race ${versus}.`
    : 'Connect your bike, or use the simulator, to start.';
  $('model-note').textContent = settings.model.calibrated
    ? 'Resistance calibrated for your bike.'
    : 'Resistance targets use a generic model until you calibrate.';
  $('baseline').value = settings.baselineW;
  for (const b of document.querySelectorAll('.mode-toggle .seg')) {
    const on = b.dataset.mode === settings.targetMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('calib-nudge').hidden = settings.targetMode !== 'knob' || !knobIsEstimate();
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

$('baseline').addEventListener('change', (e) => {
  const v = Math.round(Number(e.target.value));
  if (!(v >= 60 && v <= 600)) {
    e.target.value = settings.baselineW;
    toast('Baseline should be between 60 and 600 W.');
    return;
  }
  saveSettings({ baselineW: v });
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
  a.download = `ghostride-${new Date().toISOString().slice(0, 10)}.json`;
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
  } catch (err) {
    toast(`Couldn't import that file: ${err.message}`);
  }
  e.target.value = '';
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
  }
  calib.onReading(fields);
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
    setTimeout(() => finishRide(true), 400);
  } else {
    chimes.play(ev);
  }
}

function startRide(workout) {
  if (state.bikeState !== 'connected') {
    toast('Connect your bike or use the simulator first.');
    return;
  }
  chimes.unlock();
  state.workout = workout;
  const ghost = pickGhost(workout);
  state.session = new RideSession({ workout, baselineW: settings.baselineW, model: settings.model, ghost });
  state.started = false;
  state.paused = false;
  state.lastAdvance = clock();
  state.ride = { workout, ghost, prevBest: storage.bestRide(workout.code), prevLast: storage.lastRide(workout.code) };
  scene.setWorkout(workout);
  $('route-svg').innerHTML = routeSvg(workout, ROUTE_W, ROUTE_H);
  $('route-label').textContent = `Route · ${workout.name} ${workout.minutes} min`;
  $('pip-note').textContent = pipSupported() ? '' : 'Floating windows need Chrome or Edge 116+. You can still snap this window beside your show.';
  $('btn-pip-big').disabled = !pipSupported();
  $('btn-pip').disabled = !pipSupported();
  updatePauseButton();
  showScreen('ride');
  state.lastDom = 0;
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
  $('countdown').classList.toggle('soon', state.started && !state.paused && !!next && snap.stepLeft <= 10);

  const live = state.started && !snap.noSignal;
  const sprint = seg.kind === 'sprint';
  const estimate = knobIsEstimate();
  const resNow = snap.resistance === null ? '–' : String(snap.resistance);
  const cadenceTile = {
    label: 'Cadence · rpm',
    big: formatRange(snap.cadenceRange),
    now: String(snap.cadence),
    status: live ? snap.cadenceStatus : '',
  };
  if (settings.targetMode === 'watts') {
    setTile('a', {
      label: 'Power · W',
      big: sprint ? 'All out' : formatRange(snap.wattsRange),
      now: String(snap.powerW),
      status: live ? (snap.onTarget ? 'on' : sprint || snap.powerW < snap.targetW ? 'low' : 'high') : '',
    });
    setTile('b', cadenceTile);
    $('aside-line').textContent = `Resistance ${estimate ? '≈' : ''}${formatRange(snap.knobRange)} · now ${resNow}`;
  } else {
    setTile('a', cadenceTile);
    setTile('b', {
      label: estimate ? 'Resistance · est.' : 'Resistance',
      big: formatRange(snap.knobRange),
      now: resNow,
      status: live ? snap.knobStatus : '',
    });
    $('aside-line').textContent = sprint ? `All out! · now ${snap.powerW} W` : `Target ${snap.targetW} W · now ${snap.powerW} W`;
  }
  const cue = $('cue');
  cue.className = `cue cue-${snap.cue.type}`;
  if (cue.dataset.icon !== snap.cue.type) {
    $('cue-icon').innerHTML = ICONS[snap.cue.type];
    cue.dataset.icon = snap.cue.type;
  }
  $('cue-text').textContent = state.started ? snap.cue.text : 'Start pedalling';

  updateRoute($('ride-panel'), s.workout, snap.t, ROUTE_W, ROUTE_H);
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

function setTile(key, { label, big, now, status }) {
  $(`tile-${key}-lbl`).textContent = label;
  $(`tile-${key}-big`).textContent = big;
  $(`tile-${key}-now`).textContent = now;
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

$('btn-mute').addEventListener('click', () => {
  chimes.muted = !chimes.muted;
  saveSettings({ muted: chimes.muted });
  updateMute();
});

function updateMute() {
  $('btn-mute').setAttribute('aria-pressed', String(chimes.muted));
  $('btn-mute').setAttribute('aria-label', chimes.muted ? 'Unmute chimes' : 'Mute chimes');
  $('mute-wave').style.display = chimes.muted ? 'none' : '';
}

$('btn-end').addEventListener('click', () => {
  if (!state.session) return;
  if (!state.session.done && !window.confirm('End the ride now? Rides that end early are not saved as ghosts.')) return;
  finishRide(state.session.done);
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
      },
    });
    state.pipWin = win;
    pipDoc = win.document;
    win.addEventListener('keydown', onKey);
    win.addEventListener('resize', fitPip);
    fitPip();
    $('panel-home').classList.add('away');
    startLoop();
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

function onKey(e) {
  if (e.target?.closest?.('input, textarea, select')) return;
  if (state.screen !== 'ride' || state.bikeKind !== 'sim') return;
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
      climbs: sum.climbs,
      samples: { d: s.samples.d, p: s.samples.p, c: s.samples.c },
    };
    saved = storage.saveRide(ride);
    if (!saved) toast('Storage is full, so this ride could not be saved. Export your rides to free space.', 7000);
  }
  renderSummary({ sum, workout, prevBest, prevLast, completed, saved, session: s });
  state.session = null;
  showScreen('summary');
}

function renderSummary({ sum, workout, prevBest, prevLast, completed, saved, session }) {
  const ahead = sum.gap >= 0;
  $('sum-eyebrow').textContent = completed ? 'Ride complete' : 'Ride ended early';
  const who = sum.ghostKind === 'pacer' ? 'the pacer' : 'your ghost';
  $('sum-title').textContent = ahead ? `You beat ${who}.` : `${who === 'the pacer' ? 'The pacer' : 'Your ghost'} got you this time.`;
  const count = storage.ridesFor(workout.code).length;
  $('sum-sub').innerHTML = `${esc(workout.name)} · ${workout.minutes} min · <span style="color:var(--lavender-text)">#${esc(workout.code)}</span>${count ? ` · ridden ${count} time${count === 1 ? '' : 's'}` : ''}`;

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

  const prevClimbs = prevLast?.climbs ?? [];
  $('climbs').innerHTML = sum.climbs.length
    ? sum.climbs.map((c, i) => {
      const p = prevClimbs[i];
      const d = p ? c.avgW - p.avgW : null;
      const cls = d === null ? '' : d >= 0 ? 'up' : 'down';
      const txt = d === null ? 'new' : `${d >= 0 ? '+' : '−'}${Math.abs(d)} W`;
      const metric = settings.targetMode === 'watts'
        ? `${c.avgW} W`
        : `resistance ${c.avgKnob ?? '–'} · ${c.avgCadence} rpm`;
      return `<div class="climb"><span>${esc(c.label.replace(/ of \d+$/, ''))}</span><span class="muted">${metric}</span>
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
    if ((ratio > 1.04 || ratio < 0.9) && settings.targetMode === 'knob' && knobIsEstimate()) {
      // Following estimated knob numbers: the gap is most likely the estimate, not fitness.
      $('baseline-tip-text').textContent = `Following the resistance targets, your hard efforts came out ${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio > 1 ? 'above' : 'below'} target. Calibrate so the resistance numbers match your bike.`;
      $('btn-apply-baseline').textContent = 'Calibrate resistance';
      tip.hidden = false;
      $('btn-apply-baseline').onclick = () => {
        tip.hidden = true;
        calib.start();
      };
    } else if (ratio > 1.04 || ratio < 0.9) {
      $('btn-apply-baseline').textContent = 'Update baseline';
      const suggested = Math.round((session.baselineW * Math.min(1.08, Math.max(0.92, ratio))) / 5) * 5;
      if (suggested !== session.baselineW) {
        $('baseline-tip-text').textContent = ratio > 1
          ? `You rode the hard efforts ${Math.round((ratio - 1) * 100)}% above target. Raise your baseline to ${suggested} W?`
          : `The hard efforts were tough today (${Math.round((1 - ratio) * 100)}% under target). Lower your baseline to ${suggested} W?`;
        tip.hidden = false;
        $('btn-apply-baseline').onclick = () => {
          saveSettings({ baselineW: suggested });
          tip.hidden = true;
          toast(`Baseline set to ${suggested} W.`);
        };
      }
    }
  }
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

const LEVELS = [20, 30, 40, 50, 60, 70, 80];
const SETTLE_S = 6;
const RECORD_S = 12;

const calib = {
  open: false,
  phase: 'intro',
  level: 0,
  started: 0,
  samples: [],
  levelSamples: [],
  model: null,
  timer: null,

  start() {
    if (state.bikeState !== 'connected') {
      toast('Connect your bike (or the simulator) before calibrating.');
      return;
    }
    this.open = true;
    this.phase = 'intro';
    this.samples = [];
    this.model = null;
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
    this.started = performance.now();
    this.levelSamples = [];
    if (state.bikeKind === 'sim') {
      // Stand-in for the rider turning the knob.
      setSimMode('manual');
      state.bike.manualResistance = LEVELS[i];
      state.bike.manualCadence = 80 + (i % 3) * 5;
    }
    this.render();
  },

  onReading(f) {
    if (!this.open || this.phase !== 'level') return;
    const elapsed = (performance.now() - this.started) / 1000;
    if (elapsed >= SETTLE_S && f.powerW > 0 && f.cadence > 20) {
      this.levelSamples.push({ resistance: LEVELS[this.level], cadence: f.cadence, power: f.powerW });
    }
  },

  tick() {
    if (!this.open) return;
    if (this.phase === 'level') {
      const elapsed = (performance.now() - this.started) / 1000;
      if (elapsed >= SETTLE_S + RECORD_S) {
        if (this.levelSamples.length >= 3) this.samples.push(...this.levelSamples);
        else toast(`Not enough steady pedalling at level ${LEVELS[this.level]}; skipped it.`);
        this.nextLevel();
        return;
      }
    }
    this.renderLive();
  },

  nextLevel() {
    if (this.level + 1 < LEVELS.length) this.beginLevel(this.level + 1);
    else this.finish();
  },

  finish() {
    this.phase = 'result';
    this.model = fitModel(this.samples, settings.model);
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
      const native = state.latest.resistance !== undefined;
      body.innerHTML = `
        <p>${native
          ? 'Good news: your bike reports its resistance level directly, so the app reads it as you ride. You can still calibrate to improve the resistance targets.'
          : 'Your bike works out watts from cadence and the resistance level. Ride a few short steps so the app can learn that formula; then it can work out your resistance by itself and give resistance targets that match your bike’s screen.'}</p>
        <p class="muted">About ${Math.round((LEVELS.length * (SETTLE_S + RECORD_S)) / 60)} minutes. At each step, set the resistance to the level shown (check it on the bike's screen) and pedal at a steady, comfortable pace.</p>`;
      next.textContent = 'Begin';
    } else if (this.phase === 'level') {
      body.innerHTML = `
        <p class="muted small">Step ${this.level + 1} of ${LEVELS.length}</p>
        <p>Set resistance to</p>
        <div class="knob-big">${LEVELS[this.level]}</div>
        <p id="calib-phase" class="muted">Settle in…</p>
        <div class="calib-progress"><i id="calib-bar"></i></div>
        <div class="calib-live">
          <div class="stat"><span id="cl-p" class="stat-num">0 W</span><span class="stat-label">Power</span></div>
          <div class="stat"><span id="cl-c" class="stat-num">0</span><span class="stat-label">Cadence</span></div>
          <div class="stat"><span id="cl-n" class="stat-num">0</span><span class="stat-label">Readings</span></div>
        </div>`;
      next.hidden = true;
    } else {
      if (!this.model) {
        body.innerHTML = `<p class="error">Not enough readings to learn the formula. Try again and keep pedalling steadily at each step.</p>`;
        next.textContent = 'Try again';
        return;
      }
      const err = modelError(this.model, this.samples);
      const rows = LEVELS.map((l) => {
        const at = this.samples.filter((s) => s.resistance === l);
        if (!at.length) return '';
        const cad = at.reduce((a, s) => a + s.cadence, 0) / at.length;
        const p = at.reduce((a, s) => a + s.power, 0) / at.length;
        return `<tr><td>Resistance ${l}</td><td>${Math.round(cad)} rpm</td><td>${Math.round(p)} W</td><td>${Math.round(powerFor(this.model, l, cad))} W</td></tr>`;
      }).join('');
      body.innerHTML = `
        <p>Learned your bike's formula. Typical error: <b>${err.toFixed(1)} W</b>.</p>
        <table class="calib-table"><thead><tr><th>Step</th><th>Cadence</th><th>Measured</th><th>Model</th></tr></thead><tbody>${rows}</tbody></table>
        <p>Check it: set any resistance and pedal. Detected resistance: <b id="calib-detect">—</b> (compare with the bike's screen).</p>`;
      next.textContent = 'Save';
    }
  },

  renderLive() {
    const l = state.latest;
    if (this.phase === 'level') {
      const elapsed = (performance.now() - this.started) / 1000;
      const bar = $('calib-bar');
      if (!bar) return;
      bar.style.width = `${Math.min(100, (elapsed / (SETTLE_S + RECORD_S)) * 100)}%`;
      $('calib-phase').textContent = elapsed < SETTLE_S ? 'Settle in…' : 'Recording, keep it steady';
      $('cl-p').textContent = `${Math.round(l.powerW ?? 0)} W`;
      $('cl-c').textContent = String(Math.round(l.cadence ?? 0));
      $('cl-n').textContent = String(this.levelSamples.length);
    } else if (this.phase === 'result' && this.model) {
      const el = $('calib-detect');
      if (el && l.powerW > 5 && l.cadence > 20) el.textContent = String(Math.round(resistanceFor(this.model, l.powerW, l.cadence)));
    }
  },
};

$('btn-calibrate').addEventListener('click', () => calib.start());
$('btn-calibrate-nudge').addEventListener('click', () => calib.start());
$('calib-cancel').addEventListener('click', () => calib.close());
$('calib-skip').addEventListener('click', () => calib.nextLevel());
$('calib').addEventListener('cancel', () => calib.close());
$('calib-next').addEventListener('click', () => {
  if (calib.phase === 'intro') calib.beginLevel(0);
  else if (calib.phase === 'result') {
    if (calib.model) {
      saveSettings({ model: calib.model });
      toast('Calibration saved. Resistance targets now match your bike.');
      calib.close();
      renderSetup();
    } else {
      calib.samples = [];
      calib.beginLevel(0);
    }
  }
});

// ---------------------------------------------------------------- go

updateMute();
renderSetup();
showScreen('setup');
startLoop();

// Expose a tiny hook for automated checks and debugging in the console.
window.ghostride = { state, settings: () => settings, storage };
