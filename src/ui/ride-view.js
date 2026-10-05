// The ride itself: the frame loop, the ride window and everything on it, the
// mini window, sound, the keyboard, and the simulator's controls.

import { RideSession, EFFORT_MIN, EFFORT_MAX, SHORT_STEP_S, EASY_PACE_PCT } from '../core/ride.js';
import { formatRange, spokenCue, repeatsInBlock, stepAction } from '../core/cues.js';
import { TIME_SCALE, clock, storage, settings, saveSettings, activeModel, applySound, state, chimes, voice } from './store.js';
import { $, setPipDoc, toast, showScreen } from './dom.js';
import { Voice } from './audio.js';
import { rainPaper, prefersStill } from './paper.js';
import { fmtClock, fmtKm, fmtGap } from './format.js';
import { Scene } from './scene.js';
import { routeSvg, updateRoute } from './charts.js';
import { popOut, pipSupported } from './pip.js';
import { ZONE_COLORS } from './palette.js';
import { currentWorkout, pickGhost, renderSetup, resistanceIsEstimate } from './setup.js';
import { finishRide, recordRide } from './summary.js';

const SCENE_HEIGHT = 222;
const ROUTE_W = 328;
const ROUTE_H = 40;
const DOM_EVERY_MS = 200; // the numbers are redrawn five times a second, the scene every frame
const GATE_NOTICE_S = 600; // announce a sprint gate this long before it
const FINISH_NOTICE_S = 60;
const BACK_IN_SADDLE_MS = 4000;
const AUTO_PAUSE_MS = 5000; // the ride pauses after this long without pedalling
const RESUME_SAVE_MS = 5000; // how often the ride in progress is saved
const IDLE_END_MS = 30000; // after the finish, this long without pedalling ends the ride
const IDLE_SHOWN_MS = 1500; // a pause in the readings this short isn't the rider stopping
const scene = new Scene($('scene'), { height: SCENE_HEIGHT });

let lastPedalAt = 0;
let lastResumeSave = 0;

/** Called with each reading from the bike: pedalling starts the clock again after an auto-pause. */
export function notePedalling(cadence) {
  if (!(cadence > 0)) return;
  lastPedalAt = performance.now();
  if (state.autoPaused) {
    state.autoPaused = false;
    state.paused = false;
    state.lastAdvance = clock();
    updatePauseButton();
    state.lastDom = 0;
  }
}

/** Stop the clock if the pedals have stopped: stepping off for a drink shouldn't cost you the ride. */
function autoPause() {
  if (!state.started || state.paused || performance.now() - lastPedalAt < AUTO_PAUSE_MS) return;
  state.paused = true;
  state.autoPaused = true;
  updatePauseButton();
  state.lastDom = 0;
}

/** Save the ride in progress now and then, so a reload or a crash can pick it up. */
function saveProgress() {
  const now = performance.now();
  const s = state.session;
  if (!s || !state.started || s.done || now - lastResumeSave < RESUME_SAVE_MS) return;
  lastResumeSave = now;
  const { type, minutes, variant, options } = s.workout;
  storage.saveResume({ type, minutes, variant, options, ghostKind: state.ghostKind, baselineW: s.baselineW, session: s.save() });
}

export function advance() {
  if (state.advancing) return;
  state.advancing = true;
  try {
    const now = clock();
    const prev = state.lastAdvance ?? now;
    state.lastAdvance = now;
    if (state.bikeKind === 'sim') state.bike.tick(now / 1000);
    const s = state.session;
    if (s?.done && s.extra) {
      // Carrying on after the finish: it ends when the pedals stop, or on End ride.
      // Time only counts while the pedals are turning.
      const idle = performance.now() - lastPedalAt;
      if (idle > IDLE_END_MS) finishRide(true);
      else if (!state.paused && idle < IDLE_SHOWN_MS) s.updateExtra(Math.min((now - prev) / 1000, 10 * TIME_SCALE));
      return;
    }
    if (s && !s.done) autoPause();
    if (!s || state.paused || !state.started || s.done) return;
    saveProgress();
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

export function startLoop() {
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

// Sounds follow the countdown and nothing else: a heads-up before a step
// ends, a chime as the next begins, and one for the finish. Gates and
// overtakes are shown on screen but make no sound, so every chime matches
// something the rider can see happening to the timer.
function onRideEvent(ev) {
  if (ev === 'done') {
    // The ride is finished and saved, but the window stays: the rider can
    // cruise on at their easy pace for as long as they like.
    chimes.play('done');
    voice.say('Ride complete. Carry on if you like.');
    recordRide(state.session);
    // A flourish at the line, whoever won: arms up, a burst from the banner, and paper down the window.
    if (!prefersStill(loopWindow())) {
      scene.celebrate();
      rainPaper(loopWindow());
    }
    state.session.keepGoing({ kind: 'steady', pct: EASY_PACE_PCT, cadence: settings.easyCadence, label: 'Easy cruise', name: 'Easy cruise' });
    lastPedalAt = performance.now();
    state.lastDom = 0;
  } else if (ev === 'passedGhost' || ev === 'ghostPassed') {
    // The lead has changed hands: the gap pill, which flips colour, gives a bounce.
    pulse($('gap-pill'));
  } else if (ev === 'stepSoon' || ev === 'stepChange') {
    chimes.play(ev);
    if (ev === 'stepChange') {
      const snap = state.session.snapshot();
      const steps = state.session.workout.segments;
      voice.say(spokenCue(snap.seg, state.session.targetsFor(snap.seg), settings.targetMode, steps[snap.segIndex - 1], repeatsInBlock(steps, snap.segIndex)));
    }
  }
}

/** Start a ride. `resume` is a saved ride in progress (storage.loadResume()) to carry on with. */
export function startRide(workout, resume = null) {
  if (state.bikeState !== 'connected') {
    toast('Connect your bike first.');
    return;
  }
  chimes.unlock();
  state.workout = workout;
  const ghost = pickGhost(workout);
  state.session = new RideSession({ workout, baselineW: resume?.baselineW ?? settings.baselineW, model: activeModel(), ghost });
  state.session.setEffort(settings.effort);
  if (resume) state.session.restore(resume.session);
  state.started = false;
  state.paused = false;
  state.autoPaused = false;
  lastPedalAt = performance.now();
  state.lastAdvance = clock();
  state.ride = { workout, ghost, prevBest: storage.bestRide(workout.code), prevLast: storage.lastRide(workout.code) };
  state.finished = null;
  // Hills follow resistance: steeper means turn it up. Measured against an easy
  // cruise at the starting effort, so raising the effort makes the hills grow.
  state.terrainRef = state.session.targetsFor({ kind: 'steady', pct: 70, cadence: 88 }).resistance;
  applyTerrain();
  $('pip-card').hidden = !pipSupported();
  $('btn-pip').hidden = !pipSupported();
  fitPage();
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
  scene.setWorkout(s.workout, (seg) => Math.tanh((s.targetsFor(seg).resistance - ref) / 10));
  state.routeHeight = (seg) => (s.targetsFor(seg).resistance - 15) / 70;
  $('route-svg').innerHTML = routeSvg(s.workout, ROUTE_W, ROUTE_H, state.routeHeight);
}

$('btn-start').addEventListener('click', () => startRide(currentWorkout()));

/** Draw one frame: the scene every time, the numbers five times a second. */
function renderRide() {
  const s = state.session;
  const now = performance.now();
  const dt = state.lastFrame ? Math.min(0.1, (now - state.lastFrame) / 1000) : 0.016;
  state.lastFrame = now;
  const snap = s.snapshot();
  const moving = state.started && !state.paused;
  // After the finish the road keeps rolling, with the ghost held where it finished.
  const view = snap.extra ? { ...snap, t: snap.totalS + snap.extra.s, ghostSpeed: snap.speed, ghostCadence: snap.cadence } : snap;
  scene.render(moving ? view : { ...view, cadence: 0, speed: 0, ghostSpeed: 0, ghostCadence: 0 }, moving ? dt : 0);

  if (now - state.lastDom < DOM_EVERY_MS) return;
  state.lastDom = now;

  renderRace(snap);
  renderStep(s, snap);
  renderBadges(s, snap);
  renderTiles(snap);
  renderEffort(snap);
  renderOverlay(snap);
  // The route is over once the ride is: End ride takes its place.
  $('route-card').hidden = !!snap.extra;
  $('done-box').hidden = !snap.extra;
  if (snap.extra) {
    // With the pedals stopped, End ride fills up as the time before it ends by itself runs out.
    const idle = performance.now() - lastPedalAt;
    const stopped = idle > IDLE_SHOWN_MS;
    $('done-fill').style.width = stopped ? `${Math.min(100, ((idle - IDLE_SHOWN_MS) / (IDLE_END_MS - IDLE_SHOWN_MS)) * 100).toFixed(1)}%` : '0';
    $('done-hint').textContent = stopped ? `ending in ${Math.max(1, Math.ceil((IDLE_END_MS - idle) / 1000))}` : 'or just stop pedalling';
  }
  updateRoute($('ride-panel'), s.workout, snap.t, ROUTE_W, ROUTE_H, state.routeHeight);
  $('route-dist').textContent = fmtKm(snap.dist);
  if (state.bikeKind === 'sim') {
    $('sim-cad').textContent = Math.round(state.bike.cadence);
    $('sim-resistance').textContent = Math.round(state.bike.resistance);
  }
}

/** Time left, and the two pills over the scene: the gap to the ghost and what is coming. */
function renderRace(snap) {
  $('time-left').textContent = snap.extra ? `+${fmtClock(snap.extra.s)}` : fmtClock(snap.totalS - snap.t);
  $('time-lbl').textContent = snap.extra ? 'extra' : 'left';
  $('total-bar').style.width = `${Math.min(100, (snap.t / snap.totalS) * 100).toFixed(1)}%`;

  const gap = $('gap-pill');
  gap.classList.remove('ahead', 'behind', 'gate');
  if (!state.started) {
    gap.textContent = 'Ready';
    gap.dataset.word = '';
  } else if (snap.gate) {
    gap.classList.add('gate');
    gap.textContent = fmtGap(snap.gate.you - snap.gate.ghost);
    gap.dataset.word = 'in gate';
  } else {
    gap.classList.add(snap.gap >= 0 ? 'ahead' : 'behind');
    gap.textContent = fmtGap(snap.gap);
    gap.dataset.word = snap.gap >= 0 ? 'ahead' : 'behind';
  }

  const next = $('next-pill');
  const left = snap.totalS - snap.t;
  if (snap.gate) next.textContent = `Gate ${snap.gate.index + 1}/${snap.gate.count} · ${fmtClock(snap.gate.left)}`;
  else if (snap.nextGate && snap.nextGate.inS < GATE_NOTICE_S) next.textContent = `Gate ${snap.nextGate.index + 1} in ${fmtClock(snap.nextGate.inS)}`;
  else if (snap.extra) next.textContent = 'Finished';
  else if (state.started && left <= FINISH_NOTICE_S) next.textContent = `Finish in ${fmtClock(left)}`;
  else next.textContent = '';
}

/** The current step: its zone, name, countdown, and the spin class block it belongs to. */
function renderStep(s, snap) {
  const seg = snap.seg;
  const next = s.workout.segments[snap.segIndex + 1];

  const zone = $('zone-chip');
  if (seg.kind === 'sprint') {
    zone.textContent = 'GO';
    zone.style.background = '#F2765C';
  } else {
    zone.textContent = `Z${snap.zone}`;
    zone.style.background = ZONE_COLORS[snap.zone];
  }
  $('step-label').textContent = seg.label;
  $('next-label').textContent = next ? `Next: ${shortLabel(next)}` : 'Last step';
  // The cruise after the finish has no end to count down to, so it counts up.
  $('step-time').textContent = fmtClock(snap.extra ? snap.extra.s : snap.stepLeft);
  $('step-lbl').textContent = snap.extra ? 'extra' : 'left';
  $('step-bar').style.width = snap.extra ? '100%' : `${Math.min(100, (1 - snap.stepLeft / seg.dur) * 100).toFixed(1)}%`;
  // The last ten seconds of a step pulse, except in reps too short to need it.
  $('countdown').classList.toggle('soon', state.started && !state.paused && !!next && seg.dur >= SHORT_STEP_S && snap.stepLeft <= 10);

  const block = $('block-label');
  const title = seg.block && seg.block !== 'Recovery' ? seg.block : '';
  if (block.textContent !== title) {
    block.textContent = title;
    block.hidden = !title;
    if (title) pulse(block);
  }
}

/** Restart an element's "changed" pulse: a few beats, then it sits still. */
function pulse(el) {
  el.classList.remove('changed');
  void el.offsetWidth; // restart the animation
  if (state.started) el.classList.add('changed');
}

/**
 * The badges beside the countdown, shown only when there is something specific
 * to do: an action (Push, Recover, Add 2) and getting out of the saddle.
 */
function renderBadges(s, snap) {
  const seg = snap.seg;

  // Seated is the normal state and gets no badge, apart from a moment of
  // "Back in the saddle" after standing.
  const standing = seg.position === 'standing';
  const saddle = $('saddle');
  if (saddle.classList.contains('standing') !== standing) {
    clearTimeout(state.saddleTimer);
    saddle.textContent = standing ? 'Out of the saddle' : 'Back in the saddle';
    saddle.classList.toggle('standing', standing);
    saddle.hidden = !state.started;
    pulse(saddle);
    if (!standing) state.saddleTimer = setTimeout(() => { saddle.hidden = true; }, BACK_IN_SADDLE_MS);
  }

  const action = $('action');
  if (action.dataset.step === String(snap.segIndex)) { // worked out once per step
    // On a creeping climb, "Add 2" beats until the resistance has been added, then goes.
    const added = snap.resistanceStatus === 'on' || snap.resistanceStatus === 'high';
    if (seg.creep && added) action.hidden = true;
    return;
  }
  action.dataset.step = String(snap.segIndex);
  const before = s.workout.segments[snap.segIndex - 1];
  const act = stepAction(seg, before ? snap.targetResistance - s.targetsFor(before).resistance : 0);
  action.hidden = !act;
  if (!act) {
    action.textContent = '';
    return;
  }
  const changed = action.textContent !== act.text;
  action.textContent = act.text;
  action.className = `action ${act.tone}`;
  if (changed) pulse(action);
}

/** The two big tiles: cadence and resistance, or watts and cadence in watts mode. */
function renderTiles(snap) {
  const live = state.started && !snap.noSignal;
  const sprint = snap.seg.kind === 'sprint';
  const estimate = resistanceIsEstimate();
  const resistanceNow = snap.resistance === null ? '–' : String(snap.resistance);
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
    $('aside-line').textContent = `Res ${estimate ? '≈' : ''}${formatRange(snap.resistanceRange)} · now ${resistanceNow}`;
  } else {
    setTile('a', cadenceTile);
    setTile('b', {
      label: estimate ? 'Resistance · est.' : 'Resistance',
      aim: snap.resistanceIsExact ? String(snap.targetResistance) : formatRange(snap.resistanceRange),
      now: resistanceNow,
      status: live ? snap.resistanceStatus : '',
    });
    $('aside-line').textContent = sprint ? `Now ${snap.powerW} W` : `${snap.targetW} W · now ${snap.powerW}`;
  }
}

/** The effort control at the bottom of the ride window. */
function renderEffort(snap) {
  const el = $('ride-effort');
  const pct = Math.round(snap.effort * 100);
  el.textContent = `${pct}%`;
  el.classList.toggle('up', pct > 100);
  el.classList.toggle('down', pct < 100);
  $('ride-effort-down').disabled = snap.effort <= EFFORT_MIN + 1e-9;
  $('ride-effort-up').disabled = snap.effort >= EFFORT_MAX - 1e-9;
}

/** The message laid over the scene when the ride isn't moving. */
function renderOverlay(snap) {
  let msg = '';
  if (state.autoPaused) msg = 'Paused · pedal to carry on';
  else if (state.paused) msg = 'Paused';
  else if (!state.started) msg = 'Start pedalling to begin';
  else if (snap.noSignal) msg = state.bikeState === 'reconnecting' ? 'Bike dropped out · reconnecting…' : 'Waiting for the bike… keep pedalling';
  $('overlay').hidden = !msg;
  $('overlay-text').textContent = msg;
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

function togglePause() {
  if (!state.session) return;
  state.paused = !state.paused;
  state.autoPaused = false;
  lastPedalAt = performance.now();
  state.lastAdvance = clock();
  updatePauseButton();
  state.lastDom = 0;
}

$('btn-pause').addEventListener('click', togglePause);

function setSound({ muted = settings.muted, voice: spoken = settings.voice, volume = settings.volume }) {
  saveSettings({ muted, voice: spoken, volume });
  applySound();
  updateMute();
}

// The speaker button opens a small pop-up: a volume slider and whether steps are read out.
function showSoundPop(open) {
  $('sound-pop').hidden = !open;
  $('btn-mute').setAttribute('aria-expanded', String(open));
  if (open) updateMute();
}
$('btn-mute').addEventListener('click', () => showSoundPop($('sound-pop').hidden));
// A click anywhere else in the ride window puts it away. (The panel keeps its
// listeners when it moves into the mini window; the page itself would not.)
$('ride-panel').addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#sound-pop, #btn-mute')) showSoundPop(false);
});
$('volume').addEventListener('input', (e) => {
  const volume = Number(e.target.value) / 100;
  setSound({ volume: volume || settings.volume, muted: volume === 0 });
});
// Let go of the slider to hear the new level.
$('volume').addEventListener('change', () => {
  chimes.unlock();
  chimes.play('stepChange');
});
$('voice-on').addEventListener('change', (e) => {
  setSound({ voice: e.target.checked, muted: e.target.checked ? false : settings.muted });
  if (e.target.checked) voice.say('Voice callouts on.');
});

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

export function updateMute() {
  $('btn-mute').setAttribute('aria-label', chimes.muted ? 'Sound, off' : 'Sound');
  $('mute-wave').style.display = chimes.muted ? 'none' : '';
  $('volume').value = String(chimes.muted ? 0 : Math.round(settings.volume * 100));
  $('voice-on').checked = settings.voice && !settings.muted;
  $('voice-row').hidden = !Voice.supported();
}

$('btn-end').addEventListener('click', () => {
  if (!state.session) return;
  if (!state.session.done && !window.confirm('End the ride now? Rides that end early are not saved as ghosts.')) return;
  finishRide(state.session.done);
});
$('btn-done').addEventListener('click', () => finishRide(true));

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

export function letScreenSleep() {
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
        setPipDoc(null);
        $('ride-panel').style.transform = '';
        scene.pixelScale = 1;
        $('panel-home').classList.remove('away');
        startLoop();
        if (state.screen === 'ride') holdScreenAwake();
      },
    });
    state.pipWin = win;
    setPipDoc(win.document);
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
const PANEL_W = 400; // the ride panel is laid out at this width and scaled to fit

/** On a narrow screen (a phone on the handlebars), shrink the panel to the width of the page. */
function fitPage() {
  const narrow = window.innerWidth < PANEL_W + 32;
  $('panel-home').style.zoom = narrow && !(state.pipWin && !state.pipWin.closed) ? String((window.innerWidth - 16) / PANEL_W) : '';
}
window.addEventListener('resize', fitPage);

// Scale the panel to fill the floating window, so dragging it bigger makes the numbers bigger.
function fitPip() {
  const win = state.pipWin;
  if (!win || win.closed) return;
  const k = Math.max(0.5, Math.min(win.innerWidth / PANEL_W, win.innerHeight / 720));
  $('ride-panel').style.transform = `scale(${k})`;
  scene.pixelScale = k;
}

$('btn-pip').addEventListener('click', togglePip);
$('btn-pip-big').addEventListener('click', togglePip);

// Simulator controls
function simNudge(kind, d) {
  if (state.bikeKind !== 'sim') return;
  if (kind === 'cad') state.bike.nudgeCadence(d);
  else state.bike.nudgeResistance(d);
  setSimMode('manual');
}

export function setSimMode(mode) {
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
$('resistance-up').addEventListener('click', () => simNudge('resistance', 2));
$('resistance-down').addEventListener('click', () => simNudge('resistance', -2));

function nudgeEffort(steps) {
  const s = state.session;
  if (!s || state.screen !== 'ride') return;
  const before = s.effort;
  const blockBefore = String(s.snapshot().resistanceRange);
  if (s.nudgeEffort(steps) === before) return;
  // Flash what changed: the effort, and the resistance tile if its block moved.
  const changed = [$('ride-effort')];
  if (String(s.snapshot().resistanceRange) !== blockBefore) changed.push($('tile-b-aim'));
  for (const el of changed) {
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }
  applyTerrain();
  state.lastDom = 0;
}

$('ride-effort-down').addEventListener('click', () => nudgeEffort(-1));
$('ride-effort-up').addEventListener('click', () => nudgeEffort(+1));

function onKey(e) {
  if (e.target?.closest?.('input, textarea, select')) return;
  if (state.screen !== 'ride') return;
  // Space pauses, unless a button has focus, where it already means "press".
  if (e.key === ' ' && !e.target?.closest?.('button')) { e.preventDefault(); togglePause(); return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); nudgeEffort(-1); return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); nudgeEffort(+1); return; }
  if (state.bikeKind !== 'sim') return;
  const map = { ArrowUp: ['cad', 5], ArrowDown: ['cad', -5], ArrowRight: ['resistance', 2], ArrowLeft: ['resistance', -2] };
  const m = map[e.key];
  if (!m) return;
  e.preventDefault();
  simNudge(m[0], m[1]);
}
window.addEventListener('keydown', onKey);
