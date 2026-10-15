// Machine controls: what each button runs, and what each reading means.
//
// Every command here is an argv handed to execFile, never a shell string, and
// every value that reaches a command was clamped to a number first. The power
// actions are never fired by these tests: a fake exec records what WOULD run.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amphetamineReadScript,
  amphetamineSetScript,
  automationHint,
  brightnessFrac,
  clampVolume,
  describeError,
  parseAmphetamine,
  parseBrightness,
  parseVolume,
  powerCommand,
  readControls,
  readLevels,
  schedulePower,
  stepBrightness,
  stepVolume,
  volumeScript,
  mutedScript,
  type Exec,
} from "./controls.ts";

/** bb's RPC rule: every value reachable from a result must be a JSON value. */
function assertJsonValue(value: unknown, path = "$result"): void {
  assert.notEqual(value, undefined, `${path} is not a JSON value (undefined)`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonValue(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${path}.${k}`);
  }
}

// Measured on mgrin's MacBook 2026-10-15: `osascript -e 'get volume settings'`.
const LIVE_VOLUME = "output volume:75, input volume:31, alert volume:100, output muted:false\n";

test("the live volume reading parses to its level and mute state", () => {
  assert.deepEqual(parseVolume(LIVE_VOLUME), { level: 75, muted: false });
  assert.deepEqual(parseVolume("output volume:0, input volume:31, alert volume:100, output muted:true"), { level: 0, muted: true });
});

test("an output with no volume (HDMI, AirPlay) is unreadable, not 0", () => {
  // macOS reports `missing value` when the output device has no software volume.
  assert.equal(parseVolume("output volume:missing value, input volume:31, alert volume:100, output muted:missing value"), null);
  assert.equal(parseVolume(""), null);
});

test("a volume is clamped to an integer 0..100 before it reaches a command", () => {
  assert.equal(clampVolume(42.6), 43);
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume(250), 100);
  assert.equal(clampVolume(Number.NaN), null);
  assert.equal(volumeScript(43), "set volume output volume 43");
  assert.equal(mutedScript(true), "set volume output muted true");
  assert.equal(mutedScript(false), "set volume output muted false");
});

test("a key press moves volume one sixteenth, to the next grid point that way", () => {
  // The Mac's own keys step in sixteenths: 100/16 = 6.25 per press.
  assert.equal(stepVolume(75, 1), 81);
  assert.equal(stepVolume(75, -1), 69);
  assert.equal(stepVolume(0, -1), 0);
  assert.equal(stepVolume(100, 1), 100);
  assert.equal(stepVolume(98, 1), 100);
  assert.equal(stepVolume(3, -1), 0);
});

test("volume never sticks: 81 is 13/16 rounded, and the next press still moves", () => {
  // 13/16 is 81.25, stored as the integer 81 — which sits just BELOW the grid point.
  // Without a tolerance, "up from 81" lands on 81.25 again and the key does nothing.
  assert.equal(stepVolume(81, 1), 88);
  assert.equal(stepVolume(81, -1), 75);
  let v = 0;
  for (let i = 0; i < 16; i++) {
    const next = stepVolume(v, 1);
    assert.ok(next > v, `press ${i + 1} from ${v} did not move`);
    v = next;
  }
  assert.equal(v, 100, "sixteen presses from silent reach full volume");
  for (let i = 0; i < 16; i++) v = stepVolume(v, -1);
  assert.equal(v, 0, "and sixteen back reach silent");
});

test("a key press moves brightness one sixteenth, snapping an off-grid level", () => {
  // 0.6019 is what this Mac read on 2026-10-15: between 9/16 and 10/16.
  assert.equal(stepBrightness(0.60192436, 1), 10 / 16);
  assert.equal(stepBrightness(0.60192436, -1), 9 / 16);
  assert.equal(stepBrightness(10 / 16, 1), 11 / 16);
  assert.equal(stepBrightness(1, 1), 1);
  assert.equal(stepBrightness(0, -1), 0);
});

test("brightness is a fraction 0..1; anything else is unreadable", () => {
  assert.equal(parseBrightness("0.60192436\n"), 0.60192436);
  assert.equal(parseBrightness("1\n"), 1);
  assert.equal(parseBrightness("-1"), null);
  assert.equal(parseBrightness("1.5"), null);
  assert.equal(parseBrightness("nope"), null);
  assert.equal(brightnessFrac(0.25), "0.25");
  assert.equal(brightnessFrac(-1), "0");
  assert.equal(brightnessFrac(7), "1");
  assert.equal(brightnessFrac(Number.NaN), null);
});

test("Amphetamine is asked without being launched, and its answer parses", () => {
  // `tell application` launches an app that is not running; the read must not.
  assert.match(amphetamineReadScript(), /if application id "com\.if\.Amphetamine" is running then/);
  assert.equal(parseAmphetamine("true\n"), true);
  assert.equal(parseAmphetamine("false\n"), false);
  assert.equal(parseAmphetamine("not-running\n"), false);
  assert.equal(parseAmphetamine("garbage"), null);
  assert.match(amphetamineSetScript(true), /to start new session$/);
  assert.match(amphetamineSetScript(false), /to end session$/);
});

test("a command that hung is named as a probable permission prompt", () => {
  // Measured 2026-10-15: the first `tell application id "com.if.Amphetamine"` from bb
  // hung until killed, because macOS was waiting on an Automation prompt at the Mac.
  const hung = Object.assign(new Error("Command failed: /usr/bin/osascript -e if application id …"), { killed: true, signal: "SIGTERM", stderr: "" });
  assert.match(describeError(hung, "Amphetamine"), /did not answer.*Allow/);
});

test("a failed command reports its stderr, not the script it ran", () => {
  const failed = Object.assign(new Error("Command failed: /usr/bin/osascript -e tell application id …"), {
    stderr: "0:12: execution error: Amphetamine got an error: Connection is invalid. (-609)\n",
  });
  assert.equal(describeError(failed, "Amphetamine"), "0:12: execution error: Amphetamine got an error: Connection is invalid. (-609)");
  assert.equal(describeError(new Error("plain"), "Amphetamine"), "plain");
});

test("a refused Apple event names the permission to grant", () => {
  const err = new Error("Command failed: osascript\n36:52: execution error: Not authorized to send Apple events to Amphetamine. (-1743)");
  assert.match(automationHint(err, "Amphetamine") ?? "", /Privacy & Security → Automation/);
  assert.equal(automationHint(new Error("some other failure"), "Amphetamine"), null);
});

test("each power action runs exactly its own command, as an argv", () => {
  assert.deepEqual(powerCommand("sleep"), ["/usr/bin/pmset", ["sleepnow"]]);
  assert.deepEqual(powerCommand("lock"), ["/usr/bin/pmset", ["displaysleepnow"]]);
  assert.deepEqual(powerCommand("restart"), ["/usr/bin/osascript", ["-e", 'tell application "System Events" to restart']]);
  assert.deepEqual(powerCommand("shutdown"), ["/usr/bin/osascript", ["-e", 'tell application "System Events" to shut down']]);
});

test("a power action runs AFTER the reply, so the phone hears back first", async () => {
  const ran: string[][] = [];
  const exec: Exec = async (file, args) => { ran.push([file, ...args]); return ""; };
  const delayMs = schedulePower("sleep", exec, 30, () => assert.fail("no error expected"));
  assert.equal(delayMs, 30);
  assert.deepEqual(ran, [], "nothing runs synchronously");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ran, [["/usr/bin/pmset", "sleepnow"]]);
});

test("a power action that fails after the reply is reported, not swallowed", async () => {
  const exec: Exec = async () => { throw new Error("Not authorized to send Apple events to System Events. (-1743)"); };
  const errors: string[] = [];
  schedulePower("shutdown", exec, 5, (message) => errors.push(message));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /System Events/);
});

test("readControls: every reading present, every key a JSON value", async () => {
  const exec: Exec = async (file, args) => {
    if (args.join(" ").includes("get volume settings")) return LIVE_VOLUME;
    if (args.join(" ").includes("Amphetamine")) return "true\n";
    if (file === "/fake/brightness") return "0.5\n";
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  };
  const state = await readControls(exec, { amphetamineInstalled: true, brightnessHelper: "/fake/brightness" });
  assert.deepEqual(state, {
    volume: { level: 75, muted: false },
    volumeError: null,
    brightness: 0.5,
    brightnessError: null,
    amphetamine: { installed: true, active: true, error: null },
  });
  assertJsonValue(state);
});

test("readControls: a failing reader degrades to null + a reason, never throws", async () => {
  const exec: Exec = async () => { throw new Error("boom"); };
  const state = await readControls(exec, { amphetamineInstalled: true, brightnessHelper: "/fake/brightness" });
  assert.equal(state.volume, null);
  assert.match(state.volumeError ?? "", /boom/);
  assert.equal(state.brightness, null);
  assert.match(state.brightnessError ?? "", /boom/);
  assert.deepEqual(state.amphetamine, { installed: true, active: null, error: "boom" });
  assertJsonValue(state);
});

test("readControls: no Amphetamine and no brightness helper are stated, not guessed", async () => {
  const exec: Exec = async (_file, args) => {
    if (args.join(" ").includes("get volume settings")) return LIVE_VOLUME;
    throw new Error("must not be asked");
  };
  const state = await readControls(exec, { amphetamineInstalled: false, brightnessHelper: null });
  assert.deepEqual(state.amphetamine, { installed: false, active: null, error: null });
  assert.equal(state.brightness, null);
  assert.match(state.brightnessError ?? "", /helper/);
  assertJsonValue(state);
});

test("readLevels reads volume and brightness only, never Amphetamine", async () => {
  // A key press returns levels, not the full state: while macOS holds the
  // Automation prompt, the Amphetamine read hangs for its whole timeout, and a
  // volume key must not wait 8 s on it.
  const asked: string[] = [];
  const exec: Exec = async (file, args) => {
    asked.push([file, ...args].join(" "));
    if (args.join(" ").includes("get volume settings")) return LIVE_VOLUME;
    if (file === "/fake/brightness") return "0.5\n";
    throw new Error(`unexpected ${file}`);
  };
  const levels = await readLevels(exec, "/fake/brightness");
  assert.deepEqual(levels, { volume: { level: 75, muted: false }, volumeError: null, brightness: 0.5, brightnessError: null });
  assert.ok(!asked.some((a) => a.includes("Amphetamine")), asked.join(" | "));
  assertJsonValue(levels);
});
