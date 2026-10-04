import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData, encodeIndoorBikeData } from '../src/core/ftms.js';

test('parses speed, cadence and power', () => {
  const dv = encodeIndoorBikeData({ speedKmh: 31.25, cadence: 88.5, powerW: 172 });
  const d = parseIndoorBikeData(dv);
  assert.equal(d.speedKmh, 31.25);
  assert.equal(d.cadence, 88.5);
  assert.equal(d.powerW, 172);
  assert.equal(d.resistance, undefined);
});

test('reads optional resistance, distance and heart rate in field order', () => {
  const dv = encodeIndoorBikeData({ speedKmh: 20, cadence: 90, distanceM: 70000, resistance: 42, powerW: 201, heartRate: 151 });
  const d = parseIndoorBikeData(dv);
  assert.equal(d.distanceM, 70000);
  assert.equal(d.resistance, 42);
  assert.equal(d.powerW, 201);
  assert.equal(d.heartRate, 151);
});

test('"More Data" packets omit speed', () => {
  const dv = encodeIndoorBikeData({ cadence: 60 });
  const d = parseIndoorBikeData(dv);
  assert.equal(d.speedKmh, undefined);
  assert.equal(d.cadence, 60);
});

test('hand-built packet: flags 0x0044 = speed + cadence + power', () => {
  // speed 2500 (25.00 km/h), cadence 180 (90 rpm), power 150 W
  const bytes = new Uint8Array([0x44, 0x00, 0xc4, 0x09, 0xb4, 0x00, 0x96, 0x00]);
  const d = parseIndoorBikeData(new DataView(bytes.buffer));
  assert.deepEqual({ s: d.speedKmh, c: d.cadence, p: d.powerW }, { s: 25, c: 90, p: 150 });
});

test('truncated packet returns the fields read so far', () => {
  const bytes = new Uint8Array([0x44, 0x00, 0xc4, 0x09, 0xb4]);
  const d = parseIndoorBikeData(new DataView(bytes.buffer));
  assert.equal(d.speedKmh, 25);
  assert.equal(d.cadence, undefined);
  assert.equal(d.powerW, undefined);
});

test('empty packet is harmless', () => {
  assert.deepEqual(parseIndoorBikeData(new DataView(new ArrayBuffer(0))), {});
});
