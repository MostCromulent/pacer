// Connecting a bike (or the simulator) and passing its readings on.

import { BleBike } from '../core/bike.js';
import { SimulatedBike } from '../core/sim.js';
import { clock, settings, state } from './store.js';
import { $, toast } from './dom.js';
import { renderSetup } from './setup.js';
import { learnWhileRiding } from './learning.js';
import { advance, notePedalling } from './ride-view.js';
import { calib } from './calibration.js';

function attachBike(bike, kind) {
  detachBike();
  state.bike = bike;
  state.bikeKind = kind;
  state.latest = {};
  bike.addEventListener('data', onReading);
  bike.addEventListener('status', onBikeStatus);
}

function detachBike() {
  if (!state.bike) return;
  state.bike.removeEventListener('data', onReading);
  state.bike.removeEventListener('status', onBikeStatus);
  if (state.bikeKind === 'sim') state.bike.stop();
  else state.bike.disconnect();
  state.bike = null;
  state.bikeKind = null;
  setBikeStatus('disconnected', '');
}

function onBikeStatus(e) {
  setBikeStatus(e.detail.state, e.detail.name);
}

function setBikeStatus(s, name) {
  state.bikeState = s;
  const pill = $('bike-status');
  pill.classList.toggle('ok', s === 'connected');
  pill.classList.toggle('warn', s === 'connecting' || s === 'reconnecting');
  const label = {
    connected: `${name} · connected`,
    connecting: `Connecting to ${name}…`,
    reconnecting: `${name} dropped out · reconnecting…`,
    disconnected: 'No bike connected',
  }[s];
  $('bike-status-text').textContent = label;
  $('btn-sim').textContent = state.bikeKind === 'sim' ? 'Stop simulator' : 'Use simulator';
  $('btn-connect').textContent = state.bikeKind === 'ble' && s !== 'disconnected' ? 'Disconnect' : 'Connect bike';
  $('sim-card').hidden = state.bikeKind !== 'sim';
  if (state.screen === 'setup') renderSetup();
}

$('btn-connect').addEventListener('click', async (e) => {
  if (state.bikeKind === 'ble' && state.bikeState !== 'disconnected') {
    detachBike();
    return;
  }
  if (!BleBike.supported()) {
    toast('Web Bluetooth needs Chrome or Edge on a computer, opened from localhost or https.');
    return;
  }
  const bike = new BleBike();
  attachBike(bike, 'ble');
  try {
    await bike.connect({ showAll: e.shiftKey });
  } catch (err) {
    detachBike();
    if (err?.name === 'NotFoundError') {
      toast('Bike not in the list? Pedal to wake it, close other apps using it, or Shift-click Connect to show every device.', 7000);
    } else {
      toast(`Couldn't connect: ${err?.message || err}`);
    }
  }
});

$('btn-sim').addEventListener('click', () => {
  if (state.bikeKind === 'sim') {
    detachBike();
    return;
  }
  const sim = new SimulatedBike({ reportResistance: settings.simReportsResistance });
  sim.targetProvider = () => {
    const s = state.session;
    if (!s || state.screen !== 'ride') return null;
    const snap = s.snapshot();
    return { seg: snap.seg, targetW: snap.targetW, targetCadence: snap.targetCadence, targetResistance: snap.targetResistance, baselineW: s.baselineW };
  };
  attachBike(sim, 'sim');
  sim.start();
});

export function onReading(e) {
  const fields = e.detail;
  state.latest = { ...state.latest, ...fields };
  const s = state.session;
  if (s && state.screen === 'ride') {
    s.setInput({ powerW: fields.powerW, cadence: fields.cadence, resistance: fields.resistance });
    notePedalling(fields.cadence);
    if (!state.started && (fields.cadence ?? 0) > 0 && !state.paused) {
      state.started = true;
      state.lastAdvance = clock();
      notePedalling(fields.cadence);
    }
    // Real-bike notifications keep the ride moving even if no window is drawing.
    if (state.bikeKind === 'ble') advance();
    if (state.started && !state.paused) learnWhileRiding();
  }
  calib.onReading(fields);
}
