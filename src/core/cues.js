// What the app says and shows for a step: the voice cue, the one-word badge,
// and how a target range is written. Wording only; the ride engine is ride.js.

import { SHORT_STEP_S } from './ride.js';

/**
 * The one-word instruction for a step, shown as a badge: what to do, as an
 * instructor would call it. `resistanceChange` is how far the resistance target moved
 * from the step before (for a creeping climb's "Add 2").
 * Returns { text, tone } where tone is 'push' | 'recover' | 'add', or null for
 * ordinary riding, which needs no badge.
 */
export function stepAction(seg, resistanceChange = 0) {
  if (seg.creep) return { text: resistanceChange > 0 ? `Add ${resistanceChange}` : 'Build', tone: 'add' };
  switch (seg.kind) {
    case 'sprint': return { text: 'All out', tone: 'push' };
    case 'work': return { text: 'Push', tone: 'push' };
    case 'recovery': return { text: 'Recover', tone: 'recover' };
    default: return null;
  }
}

/**
 * What to say out loud when a step begins. `targets` comes from stepTargets();
 * `mode` is 'resistance' or 'watts'; `prev` is the step before.
 *
 * - An ordinary step: its name and the two numbers. "Hill. Resistance 56, cadence 68."
 * - The first step of a spin class block: the block and its rounds first, then
 *   the numbers, so they are heard once. "Cadence pushes, 3 rounds. Settle.
 *   Resistance 28, cadence 83."
 * - A step the block has already called (`repeat`): just its name. "Settle."
 * - Short steps: a single word, since there is no time for more. "Go.", "Up.",
 *   "Attack.", "Rest.", or the cadence in a spin-up.
 * - Getting out of the saddle, and back into it, is always called.
 */
export function spokenCue(seg, targets, mode = 'resistance', prev = null, repeat = false) {
  const said = seg.label.split('·').pop().replace(/[\d/]+|\bof\b/g, '').replace(/\s+/g, ' ').trim();
  const name = said.charAt(0).toUpperCase() + said.slice(1);
  const standing = seg.position === 'standing';
  const wasStanding = prev?.position === 'standing';
  const saddle = standing === wasStanding ? '' : standing ? ' Out of the saddle.' : ' Back in the saddle.';
  const numbers = seg.hold
    ? `Same resistance, cadence ${targets.cadence}.`
    : mode === 'watts'
      ? `${targets.watts} watts, cadence ${targets.cadence}.`
      : `Resistance ${targets.resistance}, cadence ${targets.cadence}.`;

  const opens = !!(seg.blockStart && seg.block && seg.block !== 'Recovery');
  const intro = opens ? `${seg.block}${seg.rounds ? `, ${seg.rounds} rounds` : ''}. ` : '';
  // No need to say "Time trial. Time trial.", or "Switchbacks, 4 rounds. Switchback."
  const named = opens && seg.block.toLowerCase().startsWith(name.toLowerCase()) ? '' : `${name}.`;
  const short = seg.dur < SHORT_STEP_S;

  if (seg.kind === 'sprint') return `${intro}${opens ? '' : 'Sprint. '}All out.${saddle}`;
  // A creeping climb only moves the resistance, so after the first step that is all that is said.
  if (seg.creep) return opens ? intro + numbers : mode === 'watts' ? `${targets.watts} watts.` : `Resistance ${targets.resistance}.`;
  if (short) {
    const word = seg.kind === 'drill' ? `Cadence ${targets.cadence}.`
      : seg.kind !== 'work' ? `${name}.`
        : standing ? 'Up.'
          : seg.name ? `${name}.` : 'Go.';
    // The first of a run of short steps still needs its numbers, once.
    const leads = opens || !(prev && prev.dur < SHORT_STEP_S);
    if (!leads || repeat) return word;
    return seg.kind === 'drill' ? intro + numbers : `${intro}${numbers} ${word}`;
  }
  if (repeat) return `${name}.${saddle}`;
  return `${intro}${named}${saddle} ${numbers}`.replace(/\s+/g, ' ').trim();
}

/** Whether this step repeats one already ridden in the same spin class block. */
export function repeatsInBlock(segments, index) {
  const seg = segments[index];
  if (!seg.block || seg.blockStart) return false;
  for (let i = index - 1; i >= 0 && segments[i].block === seg.block; i--) {
    const s = segments[i];
    if (s.name === seg.name && s.cadence === seg.cadence && s.pct === seg.pct && !!s.hold === !!seg.hold) return true;
    if (s.blockStart) break;
  }
  return false;
}

/** "80–90", or "105+" when there's no upper limit. */
export function formatRange([lo, hi]) {
  return hi === null ? `${lo}+` : `${lo}–${hi}`;
}
