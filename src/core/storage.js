// Local persistence. Everything stays in this browser; export/import moves it.

import { DEFAULT_MODEL } from './resistance.js';

// The app was called GhostRide; the old name stays in these keys and in export
// files so rides saved before the rename still load.
const KEY_SETTINGS = 'ghostride.settings.v1';
const KEY_RIDES = 'ghostride.rides.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  baselineW: 200,
  effort: 1,
  easyCadence: 80,
  model: DEFAULT_MODEL,
  muted: false,
  lastDuration: 30,
  lastType: 'intervals',
  lastGhost: 'pb',
  simReportsResistance: false,
  targetMode: 'knob',
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

  allRides() {
    const rides = safeGet(this.store, KEY_RIDES);
    return Array.isArray(rides) ? rides : [];
  }

  ridesFor(code) {
    return this.allRides().filter((r) => r.code === code).sort((a, b) => a.date.localeCompare(b.date));
  }

  bestRide(code) {
    return this.ridesFor(code).reduce((best, r) => (!best || r.distanceM > best.distanceM ? r : best), null);
  }

  lastRide(code) {
    const rides = this.ridesFor(code);
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

  exportAll() {
    return JSON.stringify({ app: 'ghostride', version: 1, settings: this.loadSettings(), rides: this.allRides() }, null, 1);
  }

  importAll(json) {
    const data = JSON.parse(json);
    if (data?.app !== 'ghostride' || !Array.isArray(data.rides)) throw new Error('Not a Pacer export file');
    const existing = new Set(this.allRides().map((r) => r.id));
    const merged = [...this.allRides(), ...data.rides.filter((r) => !existing.has(r.id))];
    safeSet(this.store, KEY_RIDES, merged);
    if (data.settings) this.saveSettings({ ...this.loadSettings(), ...data.settings });
    return data.rides.length;
  }
}
