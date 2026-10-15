// Machine controls for the System page: volume, brightness, Amphetamine and power.
//
// Three rules hold everywhere in this file:
//   * Every command is an argv for execFile, never a shell string. The only values
//     interpolated into an AppleScript line are numbers this module clamped itself
//     and the literals true/false.
//   * A reading that could not be taken is null WITH a reason, never 0 and never
//     omitted: "volume 0" and "volume unreadable" are different answers.
//   * A power action runs after the RPC reply, so the phone hears "done" before
//     the machine goes away. A failure after that point is reported, not dropped.
import { z } from "zod";

/** Runs one program and resolves to its stdout. Injected so tests never touch the Mac. */
export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export const OSASCRIPT = "/usr/bin/osascript";
export const PMSET = "/usr/bin/pmset";
export const AMPHETAMINE_ID = "com.if.Amphetamine";
export const AMPHETAMINE_APP = "/Applications/Amphetamine.app";
const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 15_000;

export const powerActionShape = z.enum(["sleep", "lock", "restart", "shutdown"]);
export type PowerAction = z.infer<typeof powerActionShape>;

export const controlsStateShape = z.object({
  volume: z.object({ level: z.number(), muted: z.boolean() }).nullable(),
  volumeError: z.string().nullable(),
  brightness: z.number().nullable(), // 0..1, built-in display
  brightnessError: z.string().nullable(),
  amphetamine: z.object({
    installed: z.boolean(),
    active: z.boolean().nullable(),
    error: z.string().nullable(),
  }),
});
export type ControlsState = z.infer<typeof controlsStateShape>;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).trim();

/** Runs a change and rethrows any failure as one readable line (see describeError). */
async function write(exec: Exec, file: string, args: string[], target: string): Promise<void> {
  try {
    await exec(file, args, WRITE_TIMEOUT_MS);
  } catch (e) {
    throw new Error(describeError(e, target));
  }
}

// ── volume ────────────────────────────────────────────────────────────────────

/** `get volume settings` → level and mute. `missing value` (HDMI, AirPlay) is unreadable. */
export function parseVolume(stdout: string): { level: number; muted: boolean } | null {
  const level = stdout.match(/output volume:(\d+)/);
  const muted = stdout.match(/output muted:(true|false)/);
  if (!level || !muted) return null;
  return { level: Number(level[1]), muted: muted[1] === "true" };
}

export function clampVolume(level: number): number | null {
  if (!Number.isFinite(level)) return null;
  return Math.min(100, Math.max(0, Math.round(level)));
}

export const volumeScript = (level: number): string => `set volume output volume ${level}`;
export const mutedScript = (muted: boolean): string => `set volume output muted ${muted ? "true" : "false"}`;

export async function setVolume(exec: Exec, level: number): Promise<void> {
  const n = clampVolume(level);
  if (n === null) throw new Error("volume must be a number");
  await write(exec, OSASCRIPT, ["-e", volumeScript(n)], "the volume");
}

export async function setMuted(exec: Exec, muted: boolean): Promise<void> {
  await write(exec, OSASCRIPT, ["-e", mutedScript(muted)], "the volume");
}

// ── brightness ────────────────────────────────────────────────────────────────

/** The helper prints a float 0..1; anything else means it could not read the display. */
export function parseBrightness(stdout: string): number | null {
  const v = Number(stdout.trim());
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/** A fraction as the helper's argument, clamped to 0..1; null for a non-number. */
export function brightnessFrac(level: number): string | null {
  if (!Number.isFinite(level)) return null;
  return String(Math.min(1, Math.max(0, level)));
}

export async function setBrightness(exec: Exec, helper: string, level: number): Promise<void> {
  const arg = brightnessFrac(level);
  if (arg === null) throw new Error("brightness must be a number");
  await write(exec, helper, ["set", arg], "the display");
}

// ── Amphetamine ───────────────────────────────────────────────────────────────

/** Asks only when it is running: `tell application` would LAUNCH it to answer. */
export const amphetamineReadScript = (): string =>
  [
    `if application id "${AMPHETAMINE_ID}" is running then`,
    `tell application id "${AMPHETAMINE_ID}" to return session is active`,
    `else`,
    `return "not-running"`,
    `end if`,
  ].join("\n");

export function parseAmphetamine(stdout: string): boolean | null {
  const v = stdout.trim();
  if (v === "true") return true;
  if (v === "false" || v === "not-running") return false;
  return null;
}

/** On starts a session with Amphetamine's own default options; off ends it. */
export const amphetamineSetScript = (active: boolean): string =>
  `tell application id "${AMPHETAMINE_ID}" to ${active ? "start new session" : "end session"}`;

export async function setAmphetamine(exec: Exec, active: boolean): Promise<void> {
  await write(exec, OSASCRIPT, ["-e", amphetamineSetScript(active)], "Amphetamine");
}

/** macOS refuses an Apple event bb was never allowed to send (-1743). Name the fix. */
export function automationHint(error: unknown, target: string): string | null {
  const m = `${message(error)} ${stderrOf(error)}`;
  if (!m.includes("-1743") && !/not authorized to send apple events/i.test(m)) return null;
  return `bb is not allowed to control ${target}. On the Mac: System Settings → Privacy & Security → Automation → bb → turn on ${target}.`;
}

const stderrOf = (error: unknown): string => {
  const s = (error as { stderr?: unknown } | null)?.stderr;
  return typeof s === "string" ? s.trim() : "";
};

/**
 * What went wrong, in a line a phone can show. execFile's own message is
 * "Command failed: <the whole script>", which says nothing; stderr says what
 * happened. A command killed by its timeout is almost always macOS waiting on an
 * Automation prompt at the Mac (measured 2026-10-15, the first Amphetamine call).
 */
export function describeError(error: unknown, target: string): string {
  const hint = automationHint(error, target);
  if (hint) return hint;
  if ((error as { killed?: unknown } | null)?.killed === true) {
    return `${target} did not answer in time. If the Mac shows a prompt asking to let bb control ${target}, click Allow.`;
  }
  return stderrOf(error) || message(error).split("\n")[0]!;
}

const explain = describeError;

// ── power ─────────────────────────────────────────────────────────────────────

/** The exact command for each power action. Restart and shut down go through
 *  System Events, so open apps get the normal chance to save; neither needs root. */
export function powerCommand(action: PowerAction): [string, string[]] {
  switch (action) {
    case "sleep":
      return [PMSET, ["sleepnow"]];
    case "lock":
      // Turns the display off. With "require password immediately" on, that locks.
      return [PMSET, ["displaysleepnow"]];
    case "restart":
      return [OSASCRIPT, ["-e", 'tell application "System Events" to restart']];
    case "shutdown":
      return [OSASCRIPT, ["-e", 'tell application "System Events" to shut down']];
  }
}

/** Schedules the action and returns the delay. Fired after the reply is on the
 *  wire; a failure then has no caller to throw to, so it goes to `onError`. */
export function schedulePower(
  action: PowerAction,
  exec: Exec,
  delayMs: number,
  onError: (message: string) => void,
): number {
  const [file, args] = powerCommand(action);
  setTimeout(() => {
    exec(file, args, WRITE_TIMEOUT_MS).catch((e) => onError(explain(e, "System Events")));
  }, delayMs);
  return delayMs;
}

// ── one key press ─────────────────────────────────────────────────────────────

/** The Mac's own volume and brightness keys move in sixteenths. */
export const KEY_STEPS = 16;

/**
 * The next sixteenth of `max` from `value`, in `direction`. An off-grid value goes to
 * the nearest grid point that way, not one full step past it. `tolerance` absorbs the
 * rounding of a stored value: volume is kept as an integer, so 13/16 = 81.25 reads back
 * as 81, and without it "up from 81" would land on 81.25 again and the key would stick.
 */
function stepLevel(value: number, max: number, direction: 1 | -1, tolerance: number): number {
  const grid = max / KEY_STEPS;
  const k = direction > 0 ? Math.floor((value + tolerance) / grid) + 1 : Math.ceil((value - tolerance) / grid) - 1;
  return Math.min(KEY_STEPS, Math.max(0, k)) * grid;
}

export const stepVolume = (level: number, direction: 1 | -1): number => Math.round(stepLevel(level, 100, direction, 0.5));
export const stepBrightness = (frac: number, direction: 1 | -1): number => stepLevel(frac, 1, direction, 1e-4);

// ── reading ───────────────────────────────────────────────────────────────────

export const levelsShape = controlsStateShape.pick({ volume: true, volumeError: true, brightness: true, brightnessError: true });
export type Levels = z.infer<typeof levelsShape>;

/** Volume and brightness only: what a key press changes, and fast. It never asks
 *  Amphetamine, whose read can hang its whole timeout on a pending Automation prompt. */
export async function readLevels(exec: Exec, brightnessHelper: string | null): Promise<Levels> {
  const [volume, brightness] = await Promise.all([
    exec(OSASCRIPT, ["-e", "get volume settings"], READ_TIMEOUT_MS).then(
      (out) => {
        const v = parseVolume(out);
        return v ? { v, err: null } : { v: null, err: "this output device has no volume control" };
      },
      (e) => ({ v: null, err: explain(e, "the volume") }),
    ),
    brightnessHelper === null
      ? Promise.resolve({ v: null, err: "the brightness helper could not be built on this Mac" })
      : exec(brightnessHelper, ["get"], READ_TIMEOUT_MS).then(
          (out) => {
            const v = parseBrightness(out);
            return v === null ? { v: null, err: "the built-in display is off or absent" } : { v, err: null };
          },
          (e) => ({ v: null, err: explain(e, "the display") }),
        ),
  ]);
  return { volume: volume.v, volumeError: volume.err, brightness: brightness.v, brightnessError: brightness.err };
}

export async function readControls(
  exec: Exec,
  deps: { amphetamineInstalled: boolean; brightnessHelper: string | null },
): Promise<ControlsState> {
  const [levels, amphetamine] = await Promise.all([
    readLevels(exec, deps.brightnessHelper),
    !deps.amphetamineInstalled
      ? Promise.resolve({ installed: false, active: null, error: null })
      : exec(OSASCRIPT, ["-e", amphetamineReadScript()], READ_TIMEOUT_MS).then(
          (out) => {
            const active = parseAmphetamine(out);
            return { installed: true, active, error: active === null ? `unexpected answer: ${out.trim().slice(0, 80)}` : null };
          },
          (e) => ({ installed: true, active: null, error: explain(e, "Amphetamine") }),
        ),
  ]);
  return { ...levels, amphetamine };
}
