// The one thing this file exists to prevent: a battery state carrying a key
// whose value is `undefined`.
//
// bb's RPC serialiser walks the result and refuses `undefined` — it is not a
// JSON value — and it fails the WHOLE call, not the field. On 2026-09-09 this
// Mac, sitting on AC power with no time estimate, produced
//
//   system@0.1.0  running  (rpc current failed: rpc result at
//   $result.sample.battery.minutesRemaining is not a JSON value (undefined))
//
// and the System panel rendered nothing at all (MX-835). `JSON.stringify`
// DROPS such keys, so `encodeBattery`/`decodeBattery` round-trip clean and no
// persisted-path test could ever have caught it; the assertion below is on the
// live object, and it is `assertJsonValue` — the serialiser's rule, not a spot
// check on one field name, because the next field added is the next outage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asMinutes,
  asPct,
  batteryFromRemote,
  batteryFromSi,
  decodeBattery,
  encodeBattery,
  presentBattery,
  withBattery,
} from "./battery.ts";

/** bb's rule: every value reachable from the result must be a JSON value. */
function assertJsonValue(value: unknown, path = "$result"): void {
  assert.notEqual(value, undefined, `${path} is not a JSON value (undefined)`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonValue(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${path}.${k}`);
  }
}

// Measured on mgrin's MacBook 2026-09-09T01:18Z, plugged in: IOKit reports
// timeRemaining 65535 (0xFFFF, "no estimate") and systeminformation passes it
// through verbatim. This is the exact reading that broke `current`.
const MAC_ON_AC = {
  hasBattery: true,
  cycleCount: 151,
  isCharging: false,
  designedCapacity: 74742,
  maxCapacity: 63271,
  currentCapacity: 62453,
  voltage: 12.976,
  capacityUnit: "mWh",
  percent: 100,
  timeRemaining: 65535,
  acConnected: true,
  type: "Li-ion",
  model: "bq40z651",
  manufacturer: "Apple",
  serial: "REDACTED",
};

test("MX-835: a Mac on AC with no time estimate serialises — no undefined key", () => {
  const state = batteryFromSi(MAC_ON_AC);
  assertJsonValue({ sample: { battery: state } });
  assert.equal("minutesRemaining" in (state as object), false);
  assert.deepEqual(state, {
    present: true,
    charging: false,
    acConnected: true,
    pct: 100,
    cycleCount: 151,
    healthPct: 85,
  });
});

test("a charging battery drops minutesRemaining rather than holding undefined", () => {
  const state = batteryFromSi({ ...MAC_ON_AC, isCharging: true, timeRemaining: 42 });
  assertJsonValue(state);
  assert.equal("minutesRemaining" in (state as object), false);
  assert.equal((state as { charging: boolean }).charging, true);
});

test("a discharging battery with a real estimate keeps it", () => {
  const state = batteryFromSi({ ...MAC_ON_AC, acConnected: false, timeRemaining: 137 });
  assertJsonValue(state);
  assert.equal((state as { minutesRemaining?: number }).minutesRemaining, 137);
});

test("every optional reading is omitted, not undefined, when unavailable", () => {
  const state = batteryFromSi({ hasBattery: true, acConnected: false });
  assertJsonValue(state);
  assert.deepEqual(state, { present: true, charging: false, acConnected: false });
  assert.deepEqual(Object.keys(state as object).sort(), ["acConnected", "charging", "present"]);
});

test("ABSENT and UNKNOWN stay distinct, and neither is a number", () => {
  assert.deepEqual(batteryFromSi({ hasBattery: false }), { present: false });
  assert.equal(batteryFromSi({}), undefined); // hasBattery not a boolean => UNKNOWN
  assert.equal(batteryFromSi(null), undefined);
});

test("the remote sampler omits minutes it did not emit", () => {
  const state = batteryFromRemote(
    new Map([["battery_present", "1"], ["battery_pct", "77"], ["battery_ac", "1"]]),
  );
  assertJsonValue({ sample: { battery: state } });
  assert.deepEqual(state, { present: true, charging: false, acConnected: true, pct: 77 });
});

test("the remote sampler: no key is UNKNOWN, battery_present=0 is ABSENT", () => {
  assert.equal(batteryFromRemote(new Map()), undefined);
  assert.deepEqual(batteryFromRemote(new Map([["battery_present", "0"]])), { present: false });
});

test("withBattery omits the sample key entirely when the state is UNKNOWN", () => {
  const base = { ts: 1, cpuPct: 3 };
  const unknown = withBattery(base, undefined);
  assertJsonValue({ sample: unknown });
  assert.equal("battery" in unknown, false);
  assert.deepEqual(withBattery(base, { present: false }), { ts: 1, cpuPct: 3, battery: { present: false } });
});

test("presentBattery never writes a key it was given as undefined", () => {
  const state = presentBattery(
    { charging: false, acConnected: false },
    { pct: 5, minutesRemaining: undefined, cycleCount: undefined, healthPct: undefined },
  );
  assertJsonValue(state);
  assert.deepEqual(Object.keys(state).sort(), ["acConnected", "charging", "pct", "present"]);
});

test("65535 and -1 are refused as estimates; a plausible figure is kept", () => {
  assert.equal(asMinutes(65535), undefined);
  assert.equal(asMinutes(-1), undefined);
  assert.equal(asMinutes(0), undefined);
  assert.equal(asMinutes(1439), 1439);
  assert.equal(asMinutes(1440), undefined);
});

test("a percentage outside 0..100 is not clamped into range", () => {
  assert.equal(asPct(-1), undefined);
  assert.equal(asPct(101), undefined);
  assert.equal(asPct(50.4), 50);
});

test("encode/decode round-trips the live state, UNKNOWN stays NULL", () => {
  const state = batteryFromSi(MAC_ON_AC)!;
  assert.deepEqual(decodeBattery(encodeBattery(state)), state);
  assert.equal(encodeBattery(undefined), null);
  assert.equal(decodeBattery(null), undefined);
  assert.equal(decodeBattery('{"present":"maybe"}'), undefined); // corrupt cell => UNKNOWN
});
