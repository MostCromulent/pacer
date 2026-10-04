// Bluetooth FTMS (Fitness Machine Service) helpers.
// Spec: Bluetooth SIG "Fitness Machine Service 1.0", Indoor Bike Data characteristic.

export const FTMS_SERVICE = 0x1826;
export const INDOOR_BIKE_DATA = 0x2ad2;

// Field order and sizes follow the flag bits. Bit 0 is inverted: when it is 0
// ("More Data" not set) the instantaneous speed field IS present.
const FLAG = {
  MORE_DATA: 0,
  AVG_SPEED: 1,
  INST_CADENCE: 2,
  AVG_CADENCE: 3,
  TOTAL_DISTANCE: 4,
  RESISTANCE: 5,
  INST_POWER: 6,
  AVG_POWER: 7,
  ENERGY: 8,
  HEART_RATE: 9,
  METABOLIC_EQ: 10,
  ELAPSED_TIME: 11,
  REMAINING_TIME: 12,
};

/**
 * Parse one Indoor Bike Data notification.
 * Returns only the fields present in this packet; callers should merge packets,
 * because some bikes split a reading across several notifications.
 * A truncated packet returns whatever was read before the data ran out.
 * @param {DataView} dv
 */
export function parseIndoorBikeData(dv) {
  const out = {};
  if (dv.byteLength < 2) return out;
  let i = 0;
  const flags = dv.getUint16(0, true);
  i = 2;
  out.flags = flags;
  const has = (bit) => (flags & (1 << bit)) !== 0;
  const room = (n) => i + n <= dv.byteLength;

  if (!has(FLAG.MORE_DATA)) {
    if (!room(2)) return out;
    out.speedKmh = dv.getUint16(i, true) / 100; i += 2;
  }
  if (has(FLAG.AVG_SPEED)) {
    if (!room(2)) return out;
    out.avgSpeedKmh = dv.getUint16(i, true) / 100; i += 2;
  }
  if (has(FLAG.INST_CADENCE)) {
    if (!room(2)) return out;
    out.cadence = dv.getUint16(i, true) / 2; i += 2;
  }
  if (has(FLAG.AVG_CADENCE)) {
    if (!room(2)) return out;
    out.avgCadence = dv.getUint16(i, true) / 2; i += 2;
  }
  if (has(FLAG.TOTAL_DISTANCE)) {
    if (!room(3)) return out;
    out.distanceM = dv.getUint16(i, true) | (dv.getUint8(i + 2) << 16); i += 3;
  }
  if (has(FLAG.RESISTANCE)) {
    if (!room(2)) return out;
    out.resistance = dv.getInt16(i, true); i += 2;
  }
  if (has(FLAG.INST_POWER)) {
    if (!room(2)) return out;
    out.powerW = dv.getInt16(i, true); i += 2;
  }
  if (has(FLAG.AVG_POWER)) {
    if (!room(2)) return out;
    out.avgPowerW = dv.getInt16(i, true); i += 2;
  }
  if (has(FLAG.ENERGY)) {
    if (!room(5)) return out;
    out.energyKcal = dv.getUint16(i, true); i += 5;
  }
  if (has(FLAG.HEART_RATE)) {
    if (!room(1)) return out;
    out.heartRate = dv.getUint8(i); i += 1;
  }
  if (has(FLAG.METABOLIC_EQ)) {
    if (!room(1)) return out;
    i += 1;
  }
  if (has(FLAG.ELAPSED_TIME)) {
    if (!room(2)) return out;
    out.elapsedS = dv.getUint16(i, true); i += 2;
  }
  if (has(FLAG.REMAINING_TIME)) {
    if (!room(2)) return out;
    out.remainingS = dv.getUint16(i, true); i += 2;
  }
  return out;
}

/**
 * Build an Indoor Bike Data packet. Used by tests and handy for debugging
 * against recorded traffic. Supports the fields this app reads.
 */
export function encodeIndoorBikeData({ speedKmh, cadence, distanceM, resistance, powerW, heartRate } = {}) {
  let flags = 0;
  const parts = [];
  if (speedKmh === undefined) flags |= 1 << FLAG.MORE_DATA;
  else parts.push(['u16', Math.round(speedKmh * 100)]);
  if (cadence !== undefined) { flags |= 1 << FLAG.INST_CADENCE; parts.push(['u16', Math.round(cadence * 2)]); }
  if (distanceM !== undefined) { flags |= 1 << FLAG.TOTAL_DISTANCE; parts.push(['u24', Math.round(distanceM)]); }
  if (resistance !== undefined) { flags |= 1 << FLAG.RESISTANCE; parts.push(['i16', Math.round(resistance)]); }
  if (powerW !== undefined) { flags |= 1 << FLAG.INST_POWER; parts.push(['i16', Math.round(powerW)]); }
  if (heartRate !== undefined) { flags |= 1 << FLAG.HEART_RATE; parts.push(['u8', Math.round(heartRate)]); }
  const size = { u8: 1, u16: 2, i16: 2, u24: 3 };
  const len = 2 + parts.reduce((a, [t]) => a + size[t], 0);
  const dv = new DataView(new ArrayBuffer(len));
  dv.setUint16(0, flags, true);
  let i = 2;
  for (const [t, v] of parts) {
    if (t === 'u8') dv.setUint8(i, v);
    if (t === 'u16') dv.setUint16(i, v, true);
    if (t === 'i16') dv.setInt16(i, v, true);
    if (t === 'u24') { dv.setUint16(i, v & 0xffff, true); dv.setUint8(i + 2, (v >> 16) & 0xff); }
    i += size[t];
  }
  return dv;
}
