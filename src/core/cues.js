// What the app says and shows for a step: the voice cue, the one-word badge,
// and how a target range is written. Wording only; the ride engine is ride.js.

import { SHORT_STEP_S } from './ride.js';
import { roundTo } from './util.js';

const PUSH_MAX_S = 60; // a push is a short burst; anything longer is just the ride
const PUSH_MORE_PCT = 8; // ...that is clearly harder than the step before
const RECOVER_LESS_PCT = 10; // a recovery is worth announcing when it follows something clearly harder
const SPIN_UP_RPM = 10; // this much faster on the same resistance is a spin-up
const EASE_OFF_LEVELS = 8; // this much resistance coming off is worth a word

/**
 * The badge for a step, or null. A badge marks a moment, not a state: it says
 * what to do differently from the step before (`prev`).
 * - "All out" for a sprint.
 * - "Push" for a short burst that is harder than what came before it. A long
 *   climb is not a push.
 * - "Spin up" when the resistance stays and only the legs go faster.
 * - "Set 52" at the start of a creeping climb (`setTo` is the resistance to
 *   set), then "Add 2" on each step, by how many levels it goes up.
 * - "Recover" when easing off after something harder, whether that is a
 *   recovery proper, the easy half of a round of pushes, sitting back down
 *   after a standing push, or the cool-down.
 * - "Ease off" when a lot of resistance comes off without the effort easing,
 *   as when a slow heavy climb gives way to fast flat road.
 */
export function stepAction(seg, resistanceChange = 0, prev = null, setTo = null) {
  if (seg.creep && !prev?.creep && setTo !== null) return { text: `Set ${setTo}`, tone: 'add' };
  if (seg.creep) return { text: resistanceChange > 0 ? `Add ${resistanceChange}` : 'Build', tone: 'add' };
  if (seg.kind === 'sprint') return { text: 'All out', tone: 'push' };
  if (!prev) return null;
  if (seg.hold && roundTo(seg.cadence, 5) >= roundTo(prev.cadence, 5) + SPIN_UP_RPM) return { text: 'Spin up', tone: 'push' };
  if (seg.kind === 'work' && seg.dur <= PUSH_MAX_S && seg.pct >= prev.pct + PUSH_MORE_PCT) return { text: 'Push', tone: 'push' };
  // (The cool-down is a recovery as it starts, not at each step down within it.)
  const easy = seg.kind === 'recovery' || seg.kind === 'steady' || (seg.kind === 'cooldown' && prev.kind !== 'cooldown');
  if (easy && prev.pct >= seg.pct + RECOVER_LESS_PCT) return { text: 'Recover', tone: 'recover' };
  if (!seg.hold && resistanceChange <= -EASE_OFF_LEVELS) {
    // Sitting back down from a standing push is the rest in the round, however hard the climb.
    const sitting = prev.position === 'standing' && seg.position !== 'standing';
    return { text: sitting ? 'Recover' : 'Ease off', tone: 'recover' };
  }
  return null;
}

/**
 * What to say out loud when a step begins. `targets` comes from stepTargets();
 * `mode` is 'resistance' or 'watts'; `prev` is the step before.
 *
 * - An ordinary step: its name and the two numbers. "Hill. Resistance 56, cadence 68."
 *   On a knob with no numbers, the feel instead: "Hill. Heavy, cadence 68."
 * - The first step of a spin class block: the block and its rounds first, then
 *   the numbers, so they are heard once. "Cadence pushes, 3 rounds. Recover.
 *   Resistance 28, cadence 83."
 * - A step the block has already called (`repeat`): just its name. "Recover."
 * - Short steps: a single word, since there is no time for more. "Go.", "Up.",
 *   "Attack.", "Rest.", or the cadence in a spin-up.
 * - Getting out of the saddle, and back into it, is always called.
 * - Each round of a spin class block after the first is called with its
 *   number: "Heavy climb, round 2 of 5."
 */
export function spokenCue(seg, targets, mode = 'resistance', prev = null, repeat = false) {
  const name = spokenName(seg);
  const standing = seg.position === 'standing';
  const wasStanding = prev?.position === 'standing';
  const saddle = standing === wasStanding ? '' : standing ? ' Out of the saddle.' : ' Back in the saddle.';
  const numbers = seg.hold
    ? `Same resistance, cadence ${targets.cadence}.`
    : mode === 'watts'
      ? `${targets.watts} watts, cadence ${targets.cadence}.`
      : targets.feel
        ? `${targets.feel}, cadence ${targets.cadence}.`
        : `Resistance ${saidResistance(targets)}, cadence ${targets.cadence}.`;

  const opens = !!(seg.blockStart && seg.block && seg.block !== 'Recovery');
  const intro = opens ? `${seg.block}${seg.rounds ? `, ${seg.rounds} rounds` : ''}. ` : '';
  // No need to say "Time trial. Time trial.", or "Switchbacks, 4 rounds. Switchback."
  const named = opens && seg.block.toLowerCase().startsWith(name.toLowerCase()) ? '' : `${name}.`;
  const short = seg.dur < SHORT_STEP_S;

  if (seg.kind === 'sprint') return `${intro}${opens ? '' : 'Sprint. '}All out.${saddle}`;
  // A creeping climb only moves the resistance, so after the first step that is all that is said.
  if (seg.creep) return opens ? intro + numbers : mode === 'watts' ? `${targets.watts} watts.` : targets.feel ? `${targets.feel}.` : `Resistance ${targets.resistance}.`;
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
  // The round, called on the first hard step of each round after the first.
  const hard = (s) => s.kind === 'work' || s.kind === 'sprint' || s.kind === 'drill';
  const firstOfRound = seg.round > 1 && hard(seg) && !(prev && prev.block === seg.block && prev.round === seg.round && hard(prev));
  const round = firstOfRound ? `, round ${seg.round} of ${seg.roundOf}` : '';
  if (repeat) return `${name}${round}.${saddle}`;
  return `${intro}${round ? `${name}${round}.` : named}${saddle} ${numbers}`.replace(/\s+/g, ' ').trim();
}

/** A step's name as said out loud, without its count: "Heavy push 2 of 5" is "Heavy push". */
function spokenName(seg) {
  const said = seg.label.split('·').pop().replace(/[\d/]+|\bof\b/g, '').replace(/\s+/g, ' ').trim();
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * Which way a target moves from one step to the next: 'up', 'down', or '' if
 * it stays. `key` is 'resistance', 'cadence' or 'watts'.
 */
export function targetMove(now, next, key) {
  const at = (tg) => (key === 'cadence' ? tg.cadence : key === 'watts' ? tg.wattsRange[0] : tg.resistanceRange[0]);
  return at(next) > at(now) ? 'up' : at(next) < at(now) ? 'down' : '';
}

/**
 * The heads-up before a step, said a few seconds ahead so the rider can be
 * ready for it: what it is and which way things go, with the numbers left
 * for the step itself. "Coming up: heavy climb. Resistance up, cadence 65."
 */
export function upcomingCue(next, nextTargets, nowTargets, current, mode = 'resistance') {
  const opens = !!(next.blockStart && next.block && next.block !== 'Recovery');
  const what = (opens ? next.block : spokenName(next)).toLowerCase();
  if (next.kind === 'sprint') return `Coming up: ${what}. All out.`;
  const standing = next.position === 'standing';
  const saddle = standing === (current.position === 'standing') ? '' : standing ? 'Out of the saddle. ' : 'Back in the saddle. ';
  const key = mode === 'watts' ? 'watts' : 'resistance';
  const move = next.hold ? '' : targetMove(nowTargets, nextTargets, key);
  const changes = [
    move ? `${key === 'watts' ? 'Watts' : 'Resistance'} ${move}` : '',
    nextTargets.cadence !== nowTargets.cadence ? `cadence ${nextTargets.cadence}` : '',
  ].filter(Boolean).join(', ');
  const said = changes.charAt(0).toUpperCase() + changes.slice(1);
  return `Coming up: ${what}. ${saddle}${said ? `${said}.` : ''}`.trim();
}

/** "40 to 45", or the one number where a step is exact (or has no upper limit). */
function saidResistance(targets) {
  const [lo, hi] = targets.resistanceRange ?? [];
  return targets.resistanceIsExact || lo === undefined || hi === null ? String(targets.resistance) : `${lo} to ${hi}`;
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

/** The resistance to set, as written: "40–50", one level such as "4", or, on a knob with no numbers, a feel such as "Heavy". */
export function resistanceText(targets) {
  if (targets.feel) return targets.feel;
  return targets.resistanceIsExact ? String(targets.resistance) : formatRange(targets.resistanceRange);
}
