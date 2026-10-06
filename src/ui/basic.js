// Riding without a smart bike: the screen that asks what the bike's
// resistance knob looks like, and the easy pace on it.

import { DEFAULT_MODEL, resistanceFor, powerFor } from '../core/resistance.js';
import { resistanceBlock, easyPaceResistance, EASY_PACE_PCT } from '../core/ride.js';
import { onKnob, levelFor, resistanceAtLevel, FULL_KNOB, KNOB_TOP_MIN, KNOB_TOP_MAX } from '../core/knob.js';
import { resistanceText } from '../core/cues.js';
import { settings, saveSettings } from './store.js';
import { $ } from './dom.js';
import { renderSetup } from './setup.js';
import { PACE_EXAMPLES } from './pace.js';
import { useBasicBike } from './connection.js';

const EASY_PCT = EASY_PACE_PCT / 100;
const FIRST_TOP = 8; // where "Fewer numbers" starts: a common knob on magnetic bikes

// What the screen shows: the kind of knob, its top level, and the easy pace
// as a resistance on Pacer's 1-100 scale and a cadence.
const knob = { kind: 'full', top: FIRST_TOP, resistance: 50, cadence: 80, joining: false };

/** The top level of the knob being shown: 100, fewer, or 0 for no numbers. */
function topLevel() {
  return { full: FULL_KNOB, levels: knob.top, none: 0 }[knob.kind];
}

/** The baseline the screen stands for. A knob with no numbers has no resistance to set it by, so it keeps the one it had. */
function baselineW() {
  if (knob.kind === 'none') return settings.basicBaselineW;
  const r = resistanceAtLevel(levelFor(knob.resistance, topLevel()), topLevel());
  return Math.min(900, Math.max(60, Math.round(powerFor(DEFAULT_MODEL, r, knob.cadence) / EASY_PCT)));
}

/**
 * Open the screen. `joining` is true when the rider has just chosen to ride
 * without a smart bike: saving it is what makes the switch.
 */
export function openBasic({ joining = false } = {}) {
  const top = settings.basicKnob;
  Object.assign(knob, {
    kind: top === FULL_KNOB ? 'full' : top ? 'levels' : 'none',
    top: top && top !== FULL_KNOB ? top : FIRST_TOP,
    cadence: settings.basicEasyCadence,
    resistance: easyPaceResistance(DEFAULT_MODEL, settings.basicBaselineW, settings.basicEasyCadence),
    joining,
  });
  $('basic-save').textContent = joining ? 'Continue' : 'Save';
  renderBasic();
  $('basic-dialog').showModal();
}

function renderBasic() {
  for (const b of document.querySelectorAll('#knob-kinds .seg')) {
    const on = b.dataset.knob === knob.kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('knob-top-row').hidden = knob.kind !== 'levels';
  $('knob-top').textContent = String(knob.top);
  $('knob-top-down').disabled = knob.top <= KNOB_TOP_MIN;
  $('knob-top-up').disabled = knob.top >= KNOB_TOP_MAX;
  const top = topLevel();
  $('basic-r-box').hidden = !top;
  if (top) $('basic-r').textContent = String(levelFor(knob.resistance, top));
  $('basic-c').textContent = String(knob.cadence);
  $('basic-pace-why').textContent = top
    ? 'A pace you could chat at. Every ride is built from it.'
    : 'A pace you could chat at, with the knob where it feels moderate. Steps are called lighter or heavier than that.';

  const base = baselineW();
  const easy = easyPaceResistance(DEFAULT_MODEL, base, knob.cadence);
  $('basic-rows').innerHTML = PACE_EXAMPLES.map(({ name, pct, cadence }) => {
    const exact = resistanceFor(DEFAULT_MODEL, base * pct, cadence);
    const tg = onKnob({ exactResistance: exact, resistance: Math.round(exact), resistanceRange: resistanceBlock(exact), resistanceIsExact: false }, top, easy);
    return `<tr><td>${name}</td><td>${tg.feel ? tg.feel : `resistance ${resistanceText(tg)}`} at ${cadence} rpm</td></tr>`;
  }).join('');
}

$('knob-kinds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-knob]');
  if (!b) return;
  knob.kind = b.dataset.knob;
  renderBasic();
});
for (const [id, d] of [['knob-top-down', -1], ['knob-top-up', 1]]) {
  $(id).addEventListener('click', () => {
    knob.top = Math.min(KNOB_TOP_MAX, Math.max(KNOB_TOP_MIN, knob.top + d));
    renderBasic();
  });
}
for (const [id, d] of [['basic-r-down', -1], ['basic-r-up', 1]]) {
  $(id).addEventListener('click', () => {
    const top = topLevel();
    knob.resistance = resistanceAtLevel(Math.min(top, Math.max(1, levelFor(knob.resistance, top) + d)), top);
    renderBasic();
  });
}
for (const [id, d] of [['basic-c-down', -5], ['basic-c-up', 5]]) {
  $(id).addEventListener('click', () => {
    knob.cadence = Math.min(110, Math.max(50, knob.cadence + d));
    renderBasic();
  });
}
$('basic-cancel').addEventListener('click', () => $('basic-dialog').close());
$('basic-save').addEventListener('click', () => {
  saveSettings({ basicKnob: topLevel(), basicBaselineW: baselineW(), basicEasyCadence: knob.cadence });
  $('basic-dialog').close();
  if (knob.joining) useBasicBike();
  renderSetup();
});
