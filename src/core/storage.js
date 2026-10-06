// Local persistence. Everything stays in this browser: settings, rides, and the
// bike's calibration. Export and import move all three as one backup file.

const KEY_SETTINGS = 'pacer.settings.v1';
const KEY_RIDES = 'pacer.rides.v1';
const KEY_CALIBRATION = 'pacer.calibration.v1';
const KEY_RESUME = 'pacer.resume.v1';
const RESUME_FOR_MS = 6 * 60 * 60 * 1000; // an unfinished ride can be picked up for six hours

export const DEFAULT_SETTINGS = Object.freeze({
  baselineW: 200,
  paceSet: false, // whether the rider has set their easy pace (baselineW is a guess until then)
  effort: 1,
  easyCadence: 80,
  chimes: true,
  voice: false,
  volume: 1, // 0 to 1, for chimes and the voice
  spinExclude: [],
  lastDuration: 30,
  lastType: 'intervals',
  lastGhost: 'pb',
  simReportsResistance: false,
  targetMode: 'resistance',
  // A basic bike, ridden without readings: the top level of its resistance
  // knob (100, fewer, or 0 for no numbers; see knob.js), and its own easy
  // pace, on the generic model, since it is never calibrated.
  basicKnob: 100,
  basicBaselineW: 200,
  basicEasyCadence: 80,
});

function safeGet(store, key) {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeSet(store, key, value) {
  try {
    store?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export class Storage {
  constructor(store = globalThis.localStorage) {
    this.store = store;
  }

  loadSettings() {
    return { ...DEFAULT_SETTINGS, ...(safeGet(this.store, KEY_SETTINGS) ?? {}) };
  }

  saveSettings(settings) {
    return safeSet(this.store, KEY_SETTINGS, settings);
  }

  /**
   * The bike's calibration: { bike, date, updated, model, check, bins }, or null.
   * `model` is the resistance model; `bins` are the readings it is learned from.
   */
  loadCalibration() {
    const saved = safeGet(this.store, KEY_CALIBRATION);
    return saved?.model?.calibrated ? saved : null;
  }

  saveCalibration(calibration) {
    return safeSet(this.store, KEY_CALIBRATION, calibration);
  }

  /**
   * The ride in progress, saved every few seconds so a reload or a crash
   * doesn't lose it: { savedAt, type, minutes, variant, options, ghostKind, baselineW, session }.
   */
  saveResume(ride) {
    return safeSet(this.store, KEY_RESUME, { ...ride, savedAt: Date.now() });
  }

  /** The unfinished ride, if there is one recent enough to carry on with. */
  loadResume(now = Date.now()) {
    const saved = safeGet(this.store, KEY_RESUME);
    return saved?.session && now - saved.savedAt < RESUME_FOR_MS ? saved : null;
  }

  clearResume() {
    try {
      this.store?.removeItem(KEY_RESUME);
    } catch {
      // storage unavailable: nothing to clear
    }
  }

  allRides() {
    const rides = safeGet(this.store, KEY_RIDES);
    return Array.isArray(rides) ? rides : [];
  }

  ridesFor(code) {
    return this.allRides().filter((r) => r.code === code).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** The rides on `code` that were raced: those ridden with readings, which can be ghosts. */
  racesFor(code) {
    return this.ridesFor(code).filter((r) => !r.follow);
  }

  bestRide(code) {
    return this.racesFor(code).reduce((best, r) => (!best || r.distanceM > best.distanceM ? r : best), null);
  }

  lastRide(code) {
    const rides = this.racesFor(code);
    return rides.length ? rides[rides.length - 1] : null;
  }

  saveRide(ride) {
    const rides = this.allRides();
    rides.push(ride);
    if (safeSet(this.store, KEY_RIDES, rides)) return true;
    // Out of space: drop the oldest rides that are neither a PB nor the latest for their code.
    const keep = new Set();
    for (const code of new Set(rides.map((r) => r.code))) {
      const forCode = rides.filter((r) => r.code === code);
      keep.add(forCode.reduce((a, b) => (b.distanceM > a.distanceM ? b : a)).id);
      keep.add(forCode[forCode.length - 1].id);
    }
    const trimmed = rides.filter((r) => keep.has(r.id));
    return safeSet(this.store, KEY_RIDES, trimmed);
  }

  /** Change some fields of a saved ride. */
  updateRide(id, changes) {
    return safeSet(this.store, KEY_RIDES, this.allRides().map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }

  deleteRide(id) {
    return safeSet(this.store, KEY_RIDES, this.allRides().filter((r) => r.id !== id));
  }

  exportAll() {
    return JSON.stringify({ app: 'pacer', version: 1, settings: this.loadSettings(), calibration: this.loadCalibration(), rides: this.allRides() }, null, 1);
  }

  importAll(json) {
    const data = JSON.parse(json);
    if (data?.app !== 'pacer' || !Array.isArray(data.rides)) throw new Error('Not a Pacer backup file');
    const existing = new Set(this.allRides().map((r) => r.id));
    const merged = [...this.allRides(), ...data.rides.filter((r) => !existing.has(r.id))];
    safeSet(this.store, KEY_RIDES, merged);
    if (data.settings) this.saveSettings({ ...this.loadSettings(), ...data.settings });
    if (data.calibration?.model?.calibrated) this.saveCalibration(data.calibration);
    return data.rides.length;
  }
}
