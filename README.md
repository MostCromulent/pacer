# GhostRide

Race your own ghost on a Bluetooth spin bike, in a little papercraft window that
floats beside whatever you're watching.

GhostRide connects to bikes that speak the standard Bluetooth **Fitness Machine
Service (FTMS)**, such as the Schwinn 800IC / IC4 / IC8 and Bowflex C6. It builds
a workout for the time you have, then shows the ride as a cartoon race: your
rider against a translucent ghost of your best (or last) ride on the same
workout.

> **Status: prototype.** Everything below works against the built-in simulator
> and is covered by unit tests. It has **not yet been tried with a real bike**,
> so expect some rough edges on first contact (see *Troubleshooting*).

## Quick start

Needs Node 18+ and **Chrome or Edge** on a computer. Web Bluetooth and the
floating window aren't available in Firefox or Safari.

```sh
npm start          # serves the app at http://localhost:5173
```

Open <http://localhost:5173> in Chrome or Edge. No install step: there are no
dependencies.

Want to try it without the bike? Click **Use simulator**. The simulated bike
pedals along to the workout by itself, or switch it to *I'll drive* and use the
arrow keys (↑ ↓ cadence, ← → resistance).

## Riding with the bike

1. Close Zwift, Peloton or any other app connected to the bike (it accepts one
   connection at a time) and pedal to wake the console.
2. Click **Connect bike** and pick it from the list. If it isn't listed,
   Shift-click **Connect bike** to show every Bluetooth device nearby.
3. Choose a length (sitcom 22, half hour 30, drama 45, double 60, or any length
   from 10 to 120 minutes), a workout type and who to race, then **Start ride**.
   The ride clock starts when you start pedalling.
4. Click **Pop out the mini window**. The ride moves into a small always-on-top
   window, so you can put your show full screen. Drag the window bigger and
   everything in it scales up, which helps if the screen is across the room.

### Targets are cadence and resistance

Each step gives you two ranges to stay in, the way a spin class does: a
**cadence** range (rpm) and a **resistance** range. Heavy climbs are ridden at
75–85 rpm with more resistance, recoveries spin at 87–97 rpm, and sprints at
100+. Each tile shows the range big and what you're doing now underneath, and
turns sage when you're in it, mustard when you're under, and blue when you're
over. The line underneath says which to change first, e.g.
`Resistance up to 61–65`.

Feeling strong, or having an off day? Use **Effort − / +** at the bottom of the
mini window (or the `-` and `+` keys) to make the ride easier or harder in 5%
steps, from 70% to 130%. It scales the power behind every step, so the
resistance ranges move while cadence stays the same. The summary notes the
effort you rode at, and if you held a higher (or lower) effort it offers to
make that your new baseline.

Prefer watts? Switch **Show targets as** to *Watts* on the setup screen.

### Calibrate resistance once

The 800IC has no power meter: the console works watts out from cadence and the
resistance level. **Calibrate resistance** (on the setup screen) takes about
two and a half minutes of riding: nine short steps, each asking for a
resistance *and* a cadence. A step waits until you're pedalling at its cadence,
then records ten seconds there, pausing whenever you drift off, so take as long
as you need to change the resistance. Two levels are ridden both slow and fast, which is how the app learns
what cadence does to your watts. After that the resistance numbers in the app
match the numbers on your bike's screen, and the app can tell your resistance
from the watts and cadence alone.

At the end it tells you how accurate the result is, in resistance levels: it
hides each step in turn, learns from the rest, and checks it can predict the
hidden one. The calibrated formula follows your bike's actual measurements
level by level, so it also copes with consoles that use stepped lookup tables.
It's tested against several plausible console formulas (see
`test/resistance.test.js`); every resistance target lands within ±2 levels.

Until you calibrate, resistance numbers are estimates from a generic spin-bike
curve, and the tile is labelled *est.* If your bike reports its resistance
level over Bluetooth, the app reads it directly.

## What's in the box

- **Workout generator**, sized to the minutes you choose:
  - *Steady*: endurance, recovery spin, sweet spot;
  - *Natural*: rolling hills, mountain climb (stepped climbs to a summit) and
    fartlek (easy riding with surprise surges), which vary like a real ride;
  - *Intervals*: intervals, HIIT (Tabata 20/10, 30/30 or 40/20 blocks), pyramid,
    sprints, cadence drills;
  - *Mixed*: spin class (seated and standing climbs, jumps, sprints, song by
    song) and *Mix it up* (a natural first half, then intervals: hills + HIIT,
    mountain + sprints, or fartlek + intervals).

  HIIT rests and spin-class jumps keep the resistance and change only cadence,
  as in a real class. Each
  workout has a code (e.g. `INT-30-K7Q`, or `INT-37-K7Q` for a custom 37 minutes); the same code always gives the same
  ride, which keeps ghost races fair. Shuffle for another variation, or click
  the code to type one in.
- **Ghost racing**: race your best ride on that workout, your last one, or a
  pacer that hits every target exactly. Every hard block ends in a 30-second
  **sprint gate**: a mini race against the ghost.
- **Papercraft scene**: the road *is* the workout. Its steepness follows the
  resistance target, so a steeper hill always means turn it up (and the hills
  grow when you raise the effort). The kerbs are coloured by zone, gates appear
  on the road ahead before they arrive, and riders pedal at their real cadence.
- **Glanceable mini window**, built to be read from the bike at a glance.
  Top to bottom:
  - ride time left with a progress bar;
  - the race scene, with the gap to the ghost and the next sprint gate;
  - the route ahead;
  - one box for the current stage: its name, a huge countdown (coral and
    pulsing for the last 10 seconds), and the **cadence** and **resistance**
    ranges side by side, each with what you're doing now and coloured by how
    close you are, plus a one-line hint saying what to change (watts small
    underneath);
  - soft chimes before each change (mute button in the corner).
- **Summary**: the gap to the ghost minute by minute, each hard effort compared
  with last time, and every ride of that workout. If the hard efforts were
  clearly too easy or too hard, it offers to adjust your baseline.
- **Your data stays local**: rides are kept in this browser. Use *Export rides*
  / *Import rides* to back them up or move to another computer.

## How it works

```
src/core/   pure logic, no DOM, unit-tested
  ftms.js        parse FTMS Indoor Bike Data packets
  bike.js        Web Bluetooth connection with auto-reconnect
  sim.js         simulated bike (hidden "true" watts formula)
  workout.js     deterministic workout generator, gates, zones
  resistance.js  resistance/cadence -> watts model, inversion, calibration fit
  physics.js     power -> virtual speed (flat road, eased)
  ghost.js       distance-over-time traces; pacer ghost
  ride.js        the ride engine: distance, targets, gates, events, summary
  storage.js     localStorage persistence, export/import
src/ui/     browser UI
  app.js         screens, loop, calibration wizard
  scene.js       canvas renderer for the papercraft race
  charts.js      SVG previews, route strip, race chart
  pip.js         Document Picture-in-Picture pop-out
  audio.js       chimes
```

Distance comes from **power**, not the bike's speed readout: many spin bikes
derive speed from cadence alone, which would reward spinning fast with no
resistance.

The ride keeps going when the browser window is hidden: Bluetooth notifications
drive the engine, and the pop-out window draws its own frames.

## Development

```sh
npm test                    # unit tests (node:test, no dependencies)
npm start                   # dev server
```

Add `?speed=20` to the URL to run the ride clock and simulator 20× faster, which
is handy for checking a whole ride in a minute or two.

## Troubleshooting

- **"Web Bluetooth needs Chrome or Edge"**: open the app in Chrome or Edge on a
  computer, at `http://localhost:5173` (Bluetooth is blocked on plain `http`
  addresses other than localhost).
- **Bike not in the device list**: pedal to wake it, make sure no other app is
  connected, then try Shift-click **Connect bike**. On Linux, Web Bluetooth may
  need `chrome://flags/#enable-experimental-web-platform-features`.
- **Connects but numbers stay at zero**: some bikes only send data while you
  pedal. If it still stays at zero, please note the bike model; it may need a
  "start" command over the FTMS control point, which this prototype doesn't send
  yet.
- **Watts look off**: the 800IC's watts are an estimate from the console. That's
  fine here, because you're only ever racing yourself on the same bike.
