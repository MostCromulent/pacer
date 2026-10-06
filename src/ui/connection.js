// Connecting a bike (or the simulator) and passing its readings on, or
// riding a basic bike that has none.

import { BleBike } from '../core/bike.js';
import { SimulatedBike } from '../core/sim.js';
import { clock, settings, state } from './store.js';
import { $, toast } from './dom.js';
import { renderSetup } from './setup.js';
import { learnWhileRiding } from './learning.js';
import { advance, notePedalling, announceStep } from './ride-view.js';
import { calib } from './calibration.js';
import { openBasic } from './basic.js';

const BASIC_NAME = 'No smart bike';

/** A basic bike: always there, and never says anything. */
class BasicBike extends EventTarget {
  name = BASIC_NAME;

  start() {
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'connected', name: BASIC_NAME } }));
  }

  stop() {
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'disconnected', name: BASIC_NAME } }));
  }
}

/** Ride without a smart bike, from now until a bike is connected. */
export function useBasicBike() {
  if (state.bikeKind === 'basic') return;
  const bike = new BasicBike();
  attachBike(bike, 'basic');
  bike.start();
}

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
  if (state.bikeKind === 'ble') state.bike.disconnect();
  else state.bike.stop();
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
    connected: state.bikeKind === 'basic' ? 'Riding without a smart bike' : `${name} · connected`,
    connecting: `Connecting to ${name}…`,
    reconnecting: `${name} dropped out · reconnecting…`,
    disconnected: 'No bike connected',
  }[s];
  $('bike-status-text').textContent = label;
  $('btn-sim').textContent = state.bikeKind === 'sim' ? 'Stop simulator' : 'Use simulator';
  $('btn-connect').textContent = state.bikeKind === 'ble' && s !== 'disconnected' ? 'Disconnect' : 'Connect bike';
  $('btn-basic').hidden = state.bikeKind === 'basic';
  // A basic bike has nothing to calibrate.
  $('btn-model').hidden = state.bikeKind === 'basic';
  $('sim-card').hidden = state.bikeKind !== 'sim';
  if (state.screen === 'setup') renderSetup();
}

// Tell visitors whose browser can't reach a bike before they try to connect.
if (!BleBike.supported()) {
  // Every browser on an iPhone or iPad is Safari underneath, so switching doesn't help there.
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('notice-title').textContent = apple
    ? "iPhones and iPads can't connect to a smart bike from a web page."
    : 'Pacer needs Chrome or Edge to reach a smart bike.';
  $('notice-text').textContent = apple
    ? 'Use a computer or an Android phone in Chrome or Edge, or ride without a smart bike.'
    : "This browser can't use Bluetooth. Use Chrome or Edge, or ride without a smart bike.";
  $('browser-notice').hidden = false;
  $('btn-connect').classList.add('unavailable');
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

$('btn-basic').addEventListener('click', () => openBasic({ joining: true }));

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
      announceStep(); // the first step is called as the ride starts, like every one after it
    }
    // Real-bike notifications keep the ride moving even if no window is drawing.
    if (state.bikeKind === 'ble') advance();
    if (state.started && !state.paused) learnWhileRiding();
  }
  calib.onReading(fields);
}
