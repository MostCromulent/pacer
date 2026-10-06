// A basic bike's resistance knob. Without a smart bike there is nothing to
// calibrate, so targets are worked out on Pacer's own 1-100 scale, from the
// generic model, and then put into the rider's units:
//
// - a knob marked 1 to 100: as they are;
// - a knob with fewer levels, 1 to `top`: the same travel in fewer steps;
// - a knob with no numbers (top 0): a word for how heavy it should feel,
//   measured from the easy pace, since that is the one setting the rider knows.

import { clamp } from './util.js';

export const FULL_KNOB = 100;
export const KNOB_TOP_MIN = 4;
export const KNOB_TOP_MAX = 40;

// How heavy a step is, by how far its resistance is above the easy pace's on
// the 1-100 scale. "Moderate" is the easy pace itself.
const FEELS = [
  { word: 'Light', below: -4 },
  { word: 'Moderate', below: 4 },
  { word: 'Firm', below: 11 },
  { word: 'Heavy', below: 19 },
  { word: 'Very heavy', below: Infinity },
];

/** The level on a 1-`top` knob for a resistance on the 1-100 scale. */
export function levelFor(resistance, top) {
  if (top === FULL_KNOB) return Math.round(clamp(resistance, 1, FULL_KNOB));
  return Math.round(clamp(1 + ((resistance - 1) * (top - 1)) / (FULL_KNOB - 1), 1, top));
}

/** The resistance on the 1-100 scale that a level on a 1-`top` knob stands for. */
export function resistanceAtLevel(level, top) {
  return 1 + ((level - 1) * (FULL_KNOB - 1)) / (top - 1);
}

/** 1 (Light) to 5 (Very heavy): how heavy `resistance` is next to the easy pace's `easyResistance`. */
export function feelLevel(resistance, easyResistance) {
  const above = resistance - easyResistance;
  return FEELS.findIndex((f) => above < f.below) + 1;
}

export function feelWord(level) {
  return FEELS[level - 1].word;
}

/**
 * Step targets (from stepTargets()) in the units of the rider's knob: `top` is
 * its highest level, or 0 for a knob with no numbers. The resistance fields
 * become levels on that knob, and a band that lands on one level is shown as
 * that level. With no numbers they are a feel from 1 to 5, and `feel` is its
 * word. `exactResistance` stays on the 1-100 scale, for drawing hills.
 */
export function onKnob(targets, top, easyResistance) {
  if (top === FULL_KNOB) return targets;
  const [lo, hi] = targets.resistanceRange;
  if (!top) {
    const level = feelLevel(targets.exactResistance, easyResistance);
    return { ...targets, resistance: level, resistanceRange: [level, level], resistanceIsExact: true, feel: feelWord(level) };
  }
  const range = [levelFor(lo, top), hi === null ? null : levelFor(hi, top)];
  return {
    ...targets,
    resistance: levelFor(targets.exactResistance, top),
    resistanceRange: range,
    resistanceIsExact: targets.resistanceIsExact || range[0] === range[1],
  };
}
