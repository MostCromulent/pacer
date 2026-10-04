# 🚲 Pacer

**Keep your workout on track while you watch TV.**

<img src="docs/ride.png" alt="The Pacer mini window during a hill climb" width="300" align="right">

Riding a spin bike in front of Netflix or YouTube is a great way to get the
minutes in, but it's easy to drift into a lazy spin. Pacer is a small window
that sits on top of your show and tells you what to do next: what resistance
to set, how fast to pedal, and how long until it changes.

- 📺 **Made for watching something else.** One small always-on-top window,
  readable at a glance from the saddle.
- 🎯 **Spin-class targets.** A resistance and a cadence for every step, in the
  numbers your bike's screen shows.
- 👻 **Race yourself.** Each ride is a little cartoon race against your best
  ride on that workout.
- 🪶 **Lightweight.** Runs in your browser. No account, no subscription, no
  installer, and nothing leaves your computer.

Works with bikes that use standard Bluetooth (FTMS), such as the Schwinn
800IC / IC4 / IC8 and Bowflex C6. Built and tested on a Schwinn 800IC.

<br clear="right">

## 🚀 Get started

You need a computer with Bluetooth, **Chrome or Edge**, and
[Node.js](https://nodejs.org) 18 or newer.

1. Download this repository, open a terminal in its folder and run:

   ```sh
   npm start
   ```

2. Open <http://localhost:5173> in Chrome or Edge.
3. Close any other app connected to your bike (Peloton, Zwift, JRNY), pedal a
   few turns to wake it, then click **Connect bike** and pick it from the list.
4. The first time, Pacer asks you to **calibrate**: about two and a half
   minutes of pedalling so its resistance numbers match your bike's screen.
5. Set your **easy pace** (step 3 of *Build a ride*): the resistance and
   cadence you could hold while chatting. Every ride is sized from that.

Then put your show on, build a ride and press **Start ride**.

## 🛠️ Build a ride

![Build a ride](docs/build-a-ride.png)

Four quick steps, and your choices are remembered for next time:

1. ⏱️ **Length.** A sitcom (22 min), half an hour, a drama (45), a double
   (60), or anything from 10 to 120 minutes.
2. 🗺️ **Type.** Thirteen rides in four groups: *Steady* (endurance, recovery
   spin, sweet spot), *Natural* (rolling hills, mountain climb, fartlek),
   *Intervals* (intervals, HIIT, pyramid, sprints, cadence drills) and *Mixed*
   (spin class, mix it up).
3. 💪 **Effort.** Very easy, Easy, Normal, Hard or Very hard, or an exact
   percentage. The preview shows what it will ask of you.
4. 🏁 **Race.** Your best ride on this workout, your last one, or a pacer that
   hits every target.

## 📺 During a ride

The ride opens in a small window that stays on top of everything else, so your
show can be full screen behind it. Drag it bigger if the screen is across the
room.

- 🟩 Two tiles, **cadence** and **resistance**. Green means you're in range,
  yellow means too low, blue means too high, and a line underneath says what to
  change.
- ⛰️ The road is the workout: a steeper hill means more resistance. Climbs are
  ridden slow and heavy, recoveries light and fast.
- 🔔 A soft chime warns you before each change, so you can keep your eyes on
  the show.
- ⚡ Hard blocks end in a 30-second sprint against your ghost.
- 🎚️ Having an off day? **Effort − / +** makes the rest of the ride easier or
  harder.

## 📈 After a ride

The summary shows how the race went and how each hard effort compared with
last time. **Statistics** keeps your totals, minutes per week and every ride.

![Statistics](docs/statistics.png)

## 🔧 Calibration

Most spin bikes have no power meter: they estimate watts from the resistance
and how fast you pedal, and every model does it differently. Calibrating
teaches Pacer your bike's formula. If the bike reports its resistance (the
800IC does), Pacer keeps learning from every ride.

**Calibration** in the top bar shows what it has learned.

![Calibration](docs/calibration.png)

## 💾 Your data

Rides and settings live in your browser, on your computer. **Import / export**
saves them to a backup file or loads one, which is also how you move to another
computer. Your bike's calibration is saved as `calibration.json` in the Pacer
folder.

## 🩹 If something goes wrong

- **"Web Bluetooth needs Chrome or Edge."** Open Pacer in one of those, at
  `http://localhost:5173`.
- **The bike isn't in the list.** Pedal to wake it and check that no other app
  or phone is connected to it. Still missing? Hold Shift and click **Connect
  bike** to list every Bluetooth device nearby.
- **It connects, but the numbers stay at zero.** Some bikes only send data
  while you're pedalling.
- **The resistance numbers don't match the bike's screen.** Open
  **Calibration** and calibrate again.
- **The watts look high.** They're whatever the bike reports, and bikes like
  the 800IC estimate generously. It doesn't matter here: you only race
  yourself on the same bike.
- **No small window appeared.** Floating windows need Chrome or Edge 116 or
  newer. The ride still runs in the main tab.

---

## 👩‍💻 For developers

Pacer is plain JavaScript: no dependencies, no build step, and a
[75-line static server](scripts/serve.js).

```sh
npm start    # serve the app at http://localhost:5173
npm test     # unit tests (node:test)
```

```
src/core/   logic with no browser code, covered by unit tests
  ftms.js        reads the bike's Bluetooth data packets
  bike.js        Web Bluetooth connection, with auto-reconnect
  sim.js         a simulated bike
  workout.js     the workout generator
  resistance.js  the resistance/cadence/watts model and its calibration fit
  learn.js       pools ride readings and refits the model from them
  physics.js     power to virtual speed
  ghost.js       ghost riders
  ride.js        the ride engine: targets, gates, events, summary
  storage.js     saving rides and settings, export and import
src/ui/     the browser interface
  app.js         screens, the ride loop, calibration
  scene.js       the papercraft race scene
  charts.js      charts and previews
  pip.js         the floating mini window
  audio.js       chimes
scripts/serve.js  the local server, which also saves calibration.json
```

- Add `?dev` to the address to show a **Use simulator** button, which rides
  without a bike. Add `?speed=20` to also run the clock twenty times faster.
- Every workout has a code such as `HIL-45-K7Q`. The same code always produces
  the same ride, which is what keeps ghost races fair.
- Distance comes from power, not the bike's speed reading: many spin bikes
  work out speed from cadence alone, which would reward spinning fast against
  no resistance.
- The screenshots above use sample rides, not real ones.

## 📄 Licence

[MIT](LICENSE). Use it, change it, share it.

## 🤖 How this was made

Pacer was written with AI assistance. The code, tests and this README were
produced by [Claude Code](https://claude.com/claude-code), Anthropic's coding
assistant, directed and tested on a real bike by the repository's owner.
