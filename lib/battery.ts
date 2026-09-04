// Battery state for the System plugin — modelled as THREE states, never two.
//
//   PRESENT  a battery was found (a laptop): render the reading.
//   ABSENT   the machine reported that it has no battery (a desktop): render
//            nothing. NEVER 0%.
//   UNKNOWN  the sampler could not tell — `si.battery()` threw, the remote
//            sampler emitted no battery line, an old persisted row predates
//            the column. Say so. NEVER a number.
//
// The reason this is a separate module with no plugin imports: every function
// here is pure, so the ABSENT and UNKNOWN arms can be exercised from a fixture
// on a machine that has a battery. This machine is a laptop, so those two arms
// are not otherwise reachable, and they are the arms that matter — a laptop
// rendering wrongly is visible on screen, a desktop rendering as "0% — about to
// die" is not visible to anyone here at all.
//
// The trap this exists to avoid is `server.ts`'s remote-value reader,
// `const num = (key) => Number(values.get(key)) || 0`: a key the sampler never
// emitted coerces to 0, and `|| 0` collapses a genuine 0 into the same 0. A
// battery routed through it turns a desktop into a dying laptop. Nothing here
// uses it; absence stays `undefined` the whole way through.
import { z } from "zod";

export const batteryStateShape = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }),
  z.object({
    present: z.literal(true),
    // Optional even in the PRESENT branch: "there is a battery but its charge
    // did not parse" is a real reading, and is not the same as no battery.
    pct: z.number().optional(),
    charging: z.boolean(),
    acConnected: z.boolean(),
    minutesRemaining: z.number().optional(),
    cycleCount: z.number().optional(),
    healthPct: z.number().optional(),
  }),
]);
export type BatteryState = z.infer<typeof batteryStateShape>;

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** A percentage, or undefined — out-of-range readings are not clamped into range. */
export const asPct = (v: unknown): number | undefined => {
  const n = finite(v);
  return n === undefined || n < 0 || n > 100 ? undefined : Math.round(n);
};

// IOKit reports 65535 (0xFFFF) or -1 when it has no estimate, and
// systeminformation passes that straight through: this MacBook returns
// timeRemaining 65535 while plugged in (measured 2026-09-04). Rendered raw
// that is "45 days remaining". Anything outside a day is not an estimate.
const MAX_PLAUSIBLE_MINUTES = 24 * 60;
export const asMinutes = (v: unknown): number | undefined => {
  const n = finite(v);
  return n === undefined || n <= 0 || n >= MAX_PLAUSIBLE_MINUTES ? undefined : Math.round(n);
};

/** Map a `systeminformation` battery() result. `hasBattery` is the discriminator. */
export function batteryFromSi(raw: unknown): BatteryState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  // Not a boolean means the reading itself is unusable — UNKNOWN, not "no
  // battery". Guessing "desktop" here would silently hide a laptop's battery.
  if (typeof b.hasBattery !== "boolean") return undefined;
  if (!b.hasBattery) return { present: false };
  const charging = b.isCharging === true;
  const designed = finite(b.designedCapacity);
  const max = finite(b.maxCapacity);
  return {
    present: true,
    pct: asPct(b.percent),
    charging,
    acConnected: b.acConnected === true,
    // A "time remaining" while charging is an estimate of the wrong thing.
    minutesRemaining: charging ? undefined : asMinutes(b.timeRemaining),
    cycleCount: finite(b.cycleCount),
    healthPct:
      designed !== undefined && max !== undefined && designed > 0
        ? Math.round((max / designed) * 100)
        : undefined,
  };
}

/**
 * Map the remote sampler's `key=value` lines. A remote host may legitimately be
 * a desktop, so an absent `battery_present` key is UNKNOWN and `battery_present=0`
 * is ABSENT — two different answers, neither of them a number.
 */
export function batteryFromRemote(values: Map<string, string>): BatteryState | undefined {
  const present = values.get("battery_present");
  if (present === "0") return { present: false };
  if (present !== "1") return undefined; // absent key, or anything unrecognised
  const numeric = (key: string): number | undefined => {
    const raw = values.get(key);
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const charging = values.get("battery_charging") === "1";
  return {
    present: true,
    pct: asPct(numeric("battery_pct")),
    charging,
    acConnected: values.get("battery_ac") === "1",
    minutesRemaining: charging ? undefined : asMinutes(numeric("battery_minutes")),
  };
}

/** NULL in the column means UNKNOWN, which is what every pre-migration row is. */
export function encodeBattery(state: BatteryState | undefined): string | null {
  return state === undefined ? null : JSON.stringify(state);
}

export function decodeBattery(raw: unknown): BatteryState | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const parsed = batteryStateShape.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined; // a corrupt cell is UNKNOWN, never a reading
  }
}
