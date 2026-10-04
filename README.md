# 🚲 Pacer

**Keep your workout on track while you watch TV.**

<p align="center">
  <img src="docs/ride.png" alt="The Pacer mini window during a hill climb" width="280">
</p>

Pacer is a small window that sits on top of Netflix or YouTube while you ride
your spin bike. It tells you what resistance to set, how fast to pedal, and
how long until it changes.

- 📺 **Stays on top of your show**, and is readable at a glance from the saddle.
- 🎯 **Spin-class targets**: a resistance and a cadence for every step, in the
  numbers your bike's screen shows.
- 👻 **Race yourself**: every ride is a cartoon race against your best one.
- 🪶 **Lightweight**: it runs in your browser, with no account, and nothing
  leaves your computer.

Works with standard Bluetooth (FTMS) bikes such as the Schwinn 800IC / IC4 /
IC8 and Bowflex C6. Built and tested on a Schwinn 800IC.

## 🚀 Get started

You need **Chrome or Edge**, Bluetooth, and [Node.js](https://nodejs.org) 18+.

1. Download this repository and run `npm start` in its folder.
2. Open <http://localhost:5173>.
3. Pedal to wake the bike, click **Connect bike** and pick it from the list.
   Close Peloton, Zwift or JRNY first: a bike takes one connection at a time.
4. Calibrate when prompted (about two and a half minutes of pedalling), then
   set your **easy pace**: the resistance and cadence you could chat at.

## 🛠️ Build a ride

<p align="center">
  <img src="docs/build-a-ride.png" alt="Build a ride" width="760">
</p>

Pick a length from 10 to 120 minutes, one of thirteen kinds of ride (steady,
hills, intervals, spin class and more), how hard you want it, and who to race.
Your choices are remembered, so next time it's one click.

## 📺 During a ride

- 🟩 Two tiles, **cadence** and **resistance**, showing what you're doing now.
  Green is in range; yellow or blue with an arrow means go up or down.
- ⛰️ The road is the workout. A steeper hill means more resistance.
- 🔔 A chime warns you before each change, so your eyes can stay on the show.
- 🎚️ Off day? **Effort − / +** makes the rest of the ride easier or harder.

## 📈 Afterwards

A summary of the race, and **Statistics** with your totals and minutes per week.

<p align="center">
  <img src="docs/statistics.png" alt="Statistics" width="760">
</p>

## 🔧 Calibration

Spin bikes estimate watts from resistance and cadence, each model in its own
way. Calibrating teaches Pacer your bike's formula, and if the bike reports
its resistance (the 800IC does) it keeps learning from every ride.

<p align="center">
  <img src="docs/calibration.png" alt="Calibration" width="460">
</p>

## 🩹 Good to know

- **Bike not in the list?** Pedal to wake it, and check no other app or phone
  is connected. Shift-click **Connect bike** lists every device nearby.
- **Resistance doesn't match the bike's screen?** Calibrate again, from
  **Calibration** in the top bar.
- **Watts look high?** They're the bike's own estimate. You only race yourself,
  so it doesn't matter.
- **Your data stays on your computer.** **Statistics** has a backup button,
  and lets you delete a ride.

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

Copyright © 2026 MostCromulent.

Pacer is free software under the [GNU General Public License](LICENSE),
version 3 or later. You can use it, change it and share it; if you share a
changed version, it has to stay open under the same licence. It comes with no
warranty.

## 🤖 How this was made

Written with [Claude Code](https://claude.com/claude-code), and tested on a
real bike.
