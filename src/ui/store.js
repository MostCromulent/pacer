// Shared app state: what every screen reads and writes.
//
// - `settings`: the rider's choices, kept in the browser (see DEFAULT_SETTINGS
//   in core/storage.js). Change them with saveSettings().
// - `calibration`: the bike's resistance model and the readings it is learned
//   from, kept in the browser. Change it with saveCalibration().
// - `state`: what is happening right now. It is not saved.
//
// This module imports nothing from the other UI modules, so any of them can
// import it.

import { Storage } from '../core/storage.js';
import { DEFAULT_MODEL } from '../core/resistance.js';
import { FULL_KNOB } from '../core/knob.js';
import { Learner, addToBins } from '../core/learn.js';
import { Chimes, Voice } from './audio.js';

// Dev aids: ?dev shows the simulator and a console hook, and ?speed=20 also
// runs the ride clock (and simulator) 20x faster.
const QUERY = new URLSearchParams(location.search);
export const DEV = QUERY.has('dev') || QUERY.has('speed');
export const TIME_SCALE = Math.min(60, Math.max(1, Number(QUERY.get('speed')) || 1));
export const clock = () => performance.now() * TIME_SCALE;

export const storage = new Storage();

// ---------------------------------------------------------------- settings

export let settings = storage.loadSettings();

export function saveSettings(patch) {
  settings = { ...settings, ...patch };
  storage.saveSettings(settings);
}

// ---------------------------------------------------------------- sound

export const chimes = new Chimes();
export const voice = new Voice();

/** Chimes and voice follow the settings: each has its own switch, and they share a volume. */
export function applySound() {
  chimes.muted = !settings.chimes;
  chimes.volume = voice.volume = settings.volume;
  voice.enabled = settings.voice;
  if (!voice.enabled) voice.stop();
}
// Sound used to be one "muted" switch over both.
if (settings.muted) saveSettings({ chimes: false, voice: false, muted: false });
applySound();

// ---------------------------------------------------------------- calibration

/** { bike, date, updated, model, check, samples, bins }, or null before the first calibration. */
export let calibration = storage.loadCalibration();

/** Pools steady readings from rides into `calibration.bins`. */
export const learner = new Learner(calibration?.bins ?? {});

// The simulator's formula is made up, so its calibration is never saved.
let simModel = null;

export function setSimModel(model) {
  simModel = model;
}

/** The resistance model in use: the bike's calibration, or a generic curve until there is one. */
export function activeModel() {
  if (state.bikeKind === 'sim') return simModel ?? DEFAULT_MODEL;
  if (state.bikeKind === 'basic') return DEFAULT_MODEL;
  return calibration?.model ?? DEFAULT_MODEL;
}

/** Whether the ride is on a basic bike: followed along, with no readings. */
export function following() {
  return state.bikeKind === 'basic';
}

/**
 * The easy pace that rides are built from, `{ baselineW, easyCadence }`. A
 * basic bike has its own, on the generic model, and `knob` is the top level
 * of its resistance knob.
 */
export function easyPace() {
  return following()
    ? { baselineW: settings.basicBaselineW, easyCadence: settings.basicEasyCadence, knob: settings.basicKnob }
    : { baselineW: settings.baselineW, easyCadence: settings.easyCadence, knob: FULL_KNOB };
}

const CALIBRATION_FILE = 'calibration.json';
const onDevServer = ['localhost', '127.0.0.1'].includes(location.hostname);

/** Merge `patch` into the calibration and save it. Returns false if the browser refused. */
export function saveCalibration(patch) {
  calibration = { ...calibration, ...patch };
  const saved = storage.saveCalibration(calibration);
  // The dev server also keeps a copy as a file, handy for looking at the data.
  if (onDevServer) {
    fetch(CALIBRATION_FILE, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calibration) }).catch(() => {});
  }
  return saved;
}

/**
 * A fresh browser on the dev server picks up the calibration file, if there is
 * one. Resolves to true if it did.
 */
export async function seedCalibrationFromFile() {
  if (calibration || !onDevServer) return false;
  try {
    const res = await fetch(CALIBRATION_FILE, { cache: 'no-store' });
    const saved = res.ok ? await res.json() : null;
    if (!saved?.model?.calibrated) return false;
    const bins = saved.bins ?? {};
    if (!saved.bins) for (const s of saved.samples ?? []) addToBins(bins, s);
    calibration = { ...saved, bins };
    storage.saveCalibration(calibration);
    learner.bins = bins;
    return true;
  } catch {
    return false; // no file
  }
}

/** After a backup is imported: pick up everything it brought. */
export function reloadFromStorage() {
  settings = storage.loadSettings();
  calibration = storage.loadCalibration();
  learner.bins = calibration?.bins ?? {};
  applySound();
}

// ---------------------------------------------------------------- what is happening now

export const state = {
  screen: 'setup', // 'setup' | 'stats' | 'ride' | 'summary'

  // Build a ride
  step: 0, // which of the four setup steps is showing
  duration: settings.lastDuration,
  type: settings.lastType,
  variant: 0,
  ghostKind: settings.lastGhost,
  typeGroup: undefined, // the open group of ride types; undefined until first shown, null when all are closed
  workout: null, // the ride currently previewed
  bannerDismissed: null, // name of the bike whose "calibrate" banner was dismissed

  // The bike
  bike: null,
  bikeKind: null, // 'ble' | 'sim' | 'basic' (no smart bike: the rider follows along)
  bikeState: 'disconnected',
  latest: {}, // the newest value of each field the bike has sent

  // The ride in progress
  session: null, // RideSession
  ride: null, // { workout, ghost, prevBest, prevLast }
  finished: null, // { id, sum, saved }: the ride just completed, saved while the rider carries on
  started: false, // becomes true with the first pedal stroke, or after the countdown on a basic bike
  countdownAt: null, // when the countdown to the start began, on a basic bike
  paused: false,
  autoPaused: false, // paused because the pedals stopped; pedalling resumes it
  pipWin: null, // the mini window, when open
  terrainRef: 0, // the resistance drawn as flat road
  routeHeight: null, // (step) => 0..1 height on the route strip
  saddleTimer: null,

  // The frame loop
  lastAdvance: null,
  lastFrame: null,
  lastDom: 0,
  loopToken: 0,
  advancing: false,
};
