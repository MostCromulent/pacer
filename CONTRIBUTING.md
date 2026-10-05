# Contributing to Pacer

Pacer is plain JavaScript that runs in the browser. It has no dependencies and
no build step, and it should stay that way: a contributor needs only Node and
Chrome or Edge.

## Running it

```sh
npm start        # serve the app at http://localhost:5173
npm test         # unit tests for the core logic (node:test)
npm run check    # a small lint: parsing, unused or missing imports, missing ids
npm run smoke    # drive every screen in headless Chrome with the simulated bike
```

`npm run smoke` needs Node 22 or newer and Chrome or Edge (set `CHROME_PATH` if
it isn't found). All three checks run in CI on every push and pull request.

Two address-bar switches help when working without a bike:

- `?dev` shows a **Use simulator** button and exposes `window.pacer` in the
  console.
- `?speed=20` does the same and also runs the clock twenty times faster.

## How the code is laid out

```
src/core/      logic with no page code, covered by unit tests
  workout.js     the kinds of ride, workout codes, and the shell every ride shares
  rides.js       the main set of each ride (hills, intervals, ...)
  spinclass.js   the spin class generator: block formats, measuring them, planning a class
  ride.js        the ride engine: targets, distance, gates, events, summary
  cues.js        wording for a step: the voice cue and the badge
  review.js      a finished ride looked back on: misses, and how each block went
  resistance.js  the resistance/cadence/watts model and its calibration fit
  learn.js       pools ride readings and refits the model from them
  ghost.js       ghost riders
  physics.js     power to virtual speed
  ftms.js        reads the bike's Bluetooth data packets
  bike.js        the Web Bluetooth connection
  sim.js         a simulated bike
  storage.js     settings, rides and calibration in the browser; the backup file
  util.js        small shared helpers

src/ui/        the browser interface
  app.js         entry point: loads every screen and starts the app
  store.js       shared state: settings, calibration, and what is happening now
  dom.js         element lookup, the toast, switching screens
  format.js      how numbers are written
  setup.js       Build a ride
  pace.js        the easy pace dialog
  ride-view.js   the ride window, the frame loop, the mini window, sound, keys
  summary.js     finishing a ride and the summary
  stats.js       statistics and the backup
  connection.js  connecting a bike and passing on its readings
  learning.js    learning the model during rides
  calibration.js the calibration dialog
  model-view.js  the calibration chart and table
  scene.js       the papercraft race scene (canvas)
  charts.js      SVG charts and previews
  pip.js         the floating mini window
  audio.js       chimes and the voice

scripts/       the dev server, the lint and the smoke test
test/          unit tests, one file per core module
```

Two rules keep this manageable:

- **`src/core` never touches the page.** Anything that can be worked out
  without the DOM belongs there, with a test.
- **`store.js` and `dom.js` import nothing from the screens**, so any screen can
  import them. Screens do call each other's functions to move between screens
  (setup starts a ride, the summary goes back to setup), so some screen modules
  import each other. That is fine as long as it only happens inside functions,
  never while a module is loading.

## Words we use

The code uses the same words the rider sees.

| Word | Meaning |
|---|---|
| resistance | the number on the bike's resistance dial, 1 to 100 |
| cadence | pedalling speed in rpm |
| effort | the rider's adjustment to a whole ride, 50% to 150% |
| `baselineW` | the rider's fitness in watts. It is set and shown as an *easy pace* (the resistance and cadence of comfortable flat-road riding, which is 70% of the baseline) and never shown as a number |
| step | one part of a ride, with a cadence and an effort to hold (see the `Step` typedef in `workout.js`) |
| block | a themed run of steps in a spin class |
| ghost | the rider you race: a past ride, or the pacer that hits every target |

## Adding a kind of ride

1. Add a builder to `src/core/rides.js`. It is given a time budget in seconds
   and spends it by calling `add(seconds, pct, kind, options)`. The warm-up and
   cool-down are added around it. Use the helpers there (`stretch`, `inSets`,
   `between`) so that longer rides get longer efforts as well as more of them.
2. List it in `TYPES` in `src/core/workout.js` with the same id, a group, a
   name, a one-line hint and a new three-letter code.
3. Give it a colour in `TYPE_COLORS` in `src/ui/setup.js`.
4. Add a test in `test/workout.test.js`. The existing tests already check that
   every ride adds up to exactly its length, at every length.

## Adding a spin class block

1. Add an entry to the **end** of `SPIN_BLOCKS` in `src/core/spinclass.js`.
   The order is part of the workout code, so never insert or reorder. Mark it
   `gentle` if it can be ridden seated and easy in the low impact class.
2. Add a maker with the same id to `blockMakers`. It returns the block's steps
   and, if it repeats, how many rounds. Draw its numbers with `between` and
   `int` so no two are alike, its rounds with `reps` so a longer class gets
   more, and use `near()` for a base effort so it joins on to the block before.
3. Add a test in `test/spinclass.test.js`.

There is nothing else to label. How hard the block is, what it trains, where
it goes in the class, how much rest follows it and whether it can be the finale
are all read from its steps.

A step that holds the resistance of the one before it (`hold: true`) is ridden
at whatever effort the change of cadence makes it, so the `pct` written for it
is replaced. This applies to every kind of ride, not only spin classes.

## Workout codes

A code such as `HIL-45-K7Q` is `TYPE-MINUTES-VERSION`. The same code always
produces the same ride, which is what makes ghost races fair, so anything
random must come from the seeded generator, never from `Math.random()`.

- `K7Q`, `R2M` and `X9D` are a ride's three standard versions.
- Any other three characters are a random version.
- Spin classes may add a fourth part: the blocks left out, as a base-36 number.

Changing what a builder produces changes the ride behind existing codes, and
with it any ghosts recorded on them. That is acceptable, but say so in the
commit.

## Where data lives

Everything is in the rider's browser (`localStorage`), under three keys:
settings, rides, and the bike's calibration. Nothing is sent anywhere. The
backup file on the Statistics page holds all three.

When run with `npm start`, the dev server also keeps the calibration as
`calibration.json`, and a new browser picks it up from there. The hosted app
has no server and does not use the file.

## Style

- Match the code around you. Comments say why, not what.
- Text the rider sees is short and plain: no jargon, and no watts unless they
  ask for them.
- The ride window is read at a glance from a bike. Add to it sparingly.
- No dependencies, including for development.

## Releasing

Every push to `main` that passes its checks is published to GitHub Pages.
Pushing a tag such as `v0.2.0` also attaches a zip of the app to a GitHub
release, for anyone who wants to run it locally.
