// The "easy pace" dialog.

import { parseWorkoutCode, hasBlocks } from '../core/workout.js';
import { resistanceFor, powerFor } from '../core/resistance.js';
import { resistanceBlock, EASY_PACE_PCT } from '../core/ride.js';
import { formatRange } from '../core/cues.js';
import { DEFAULT_SETTINGS } from '../core/storage.js';
import { storage, settings, saveSettings, reloadFromStorage, activeModel, state } from './store.js';
import { $, toast } from './dom.js';
import { renderSetup } from './setup.js';
import { renderStats } from './stats.js';
import { updateMute } from './ride-view.js';

//
// Rides are scaled from a baseline in watts, which means nothing to most riders.
// So it is set and shown as an easy spin on the bike: a resistance and a cadence.

// The easy pace is comfortable flat-road riding: 70% of the baseline, the same
// as a "Flat road" step. Recovery steps sit a little below it.
const EASY_PCT = EASY_PACE_PCT / 100;
const PACE_EXAMPLES = [
  { name: 'Recovery spin', pct: 0.55, cadence: 75 },
  { name: 'Flat road', pct: 0.7, cadence: 90 },
  { name: 'Seated climb', pct: 0.9, cadence: 70 },
  // The same watts ridden two ways: heavy and slow, or light and fast.
  { name: 'Hill climb', pct: 1.05, cadence: 65 },
  { name: 'Downhill sprint', pct: 1.05, cadence: 100 },
];

function baselineFor(resistance, cadence) {
  return Math.min(900, Math.max(60, Math.round(powerFor(activeModel(), resistance, cadence) / EASY_PCT)));
}

/** The easy-spin resistance that the current baseline stands for. */
export function easyResistance(baselineW = settings.baselineW) {
  return Math.round(resistanceFor(activeModel(), baselineW * EASY_PCT, settings.easyCadence));
}

/**
 * Whether the rider has told Pacer their easy pace. Until they do, rides are
 * sized from a guess, which on a calibrated bike can be a long way out.
 */
export function paceIsSet() {
  return settings.paceSet || settings.baselineW !== DEFAULT_SETTINGS.baselineW;
}

/** Open the easy pace dialog if the bike is calibrated and the pace has never been set. */
export function askForPace() {
  if (activeModel().calibrated && !paceIsSet() && !$('pace-dialog').open) openPace();
}

const FIRST_PACE = { resistance: 25, cadence: 80 }; // where the dialog starts for someone who has never set one
const pace = { ...FIRST_PACE };

function openPace() {
  Object.assign(pace, paceIsSet() ? { resistance: easyResistance(), cadence: settings.easyCadence } : FIRST_PACE);
  renderPace();
  $('pace-dialog').showModal();
}

function renderPace() {
  $('pace-r').textContent = String(pace.resistance);
  $('pace-c').textContent = String(pace.cadence);
  const baselineW = baselineFor(pace.resistance, pace.cadence);
  $('pace-rows').innerHTML = PACE_EXAMPLES.map(({ name, pct, cadence }) => {
    const watts = baselineW * pct;
    return `<tr><td>${name}</td><td>resistance ${formatRange(resistanceBlock(resistanceFor(activeModel(), watts, cadence)))} at ${cadence} rpm</td><td>${Math.round(watts)} W</td></tr>`;
  }).join('');
  $('pace-note').textContent = activeModel().calibrated
    ? 'The hill climb and the downhill sprint are the same watts: one is heavy and slow, the other light and fast. Watts are as the bike reports them.'
    : "The bike isn't calibrated yet, so these resistances are rough.";
}

$('btn-pace').addEventListener('click', openPace);
$('btn-pace-banner').addEventListener('click', openPace);
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
  saveSettings({ baselineW: baselineFor(pace.resistance, pace.cadence), easyCadence: pace.cadence, paceSet: true });
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
  if (hasBlocks(parsed.type)) saveSettings({ spinExclude: parsed.exclude ?? [] });
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
    reloadFromStorage();
    updateMute();
    toast(`Imported ${n} ride${n === 1 ? '' : 's'}.`);
    renderSetup();
    renderStats();
    askForPace(); // a backup can bring a calibration without an easy pace
  } catch (err) {
    toast(`Couldn't import that file: ${err.message}`);
  }
  e.target.value = '';
});
