// Real bike over Web Bluetooth (Chrome / Edge, on localhost or https).

import { FTMS_SERVICE, INDOOR_BIKE_DATA, parseIndoorBikeData } from './ftms.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000];

export class BleBike extends EventTarget {
  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  constructor() {
    super();
    this.device = null;
    this.characteristic = null;
    this.latest = {};
    this._userDisconnect = false;
    this._onValue = (e) => this._handle(e.target.value);
    this._onDisconnect = () => this._reconnect();
  }

  get name() {
    return this.device?.name || 'Bike';
  }

  /**
   * Ask the user to pick a bike. By default only devices advertising the
   * Fitness Machine service are listed; `showAll` lists everything nearby for
   * bikes that don't advertise it.
   */
  async connect({ showAll = false } = {}) {
    if (!BleBike.supported()) throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge.');
    this._userDisconnect = false;
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: [FTMS_SERVICE] }
      : { filters: [{ services: [FTMS_SERVICE] }] };
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    await this._setup();
  }

  async _setup() {
    this._status('connecting');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);
    this.characteristic = await service.getCharacteristic(INDOOR_BIKE_DATA);
    this.characteristic.addEventListener('characteristicvaluechanged', this._onValue);
    await this.characteristic.startNotifications();
    this._status('connected');
  }

  _handle(dataView) {
    const fields = parseIndoorBikeData(dataView);
    delete fields.flags;
    // Bikes may split one reading over several packets; keep the newest of each field.
    this.latest = { ...this.latest, ...fields };
    this.dispatchEvent(new CustomEvent('data', { detail: fields }));
  }

  async _reconnect() {
    this.characteristic?.removeEventListener('characteristicvaluechanged', this._onValue);
    this.characteristic = null;
    if (this._userDisconnect || !this.device) {
      this._status('disconnected');
      return;
    }
    for (const delay of RETRY_DELAYS_MS) {
      this._status('reconnecting');
      await new Promise((r) => setTimeout(r, delay));
      if (this._userDisconnect) return;
      try {
        await this._setup();
        return;
      } catch {
        // try again
      }
    }
    this._status('disconnected');
  }

  disconnect() {
    this._userDisconnect = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this._status('disconnected');
  }

  _status(state) {
    this.dispatchEvent(new CustomEvent('status', { detail: { state, name: this.name } }));
  }
}
