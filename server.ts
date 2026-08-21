// bb-plugin-system — live system overview for bb.
//
// Metrics come from `systeminformation` (MIT, zero deps) rather than hand-parsed
// sysctl/vm_stat output. That is not a style preference — the hand-rolled version
// was WRONG in two ways, both measured on an M4/24GiB machine 2026-08-09:
//
//   * memory: summing `Pages active + wired + compressor` counts file-backed cache
//     as used and misses dirty anonymous pages on the inactive queue. It read
//     16.0 GiB where Activity Monitor's basis (anonymous - purgeable + wired +
//     compressed) reads 18.4 GiB. The error tracks the cache/anon split, so it
//     distorted the shape of the history graph, not just its level.
//   * cpu: `vm.loadavg / hw.ncpu` painted a 39% bar on an idle machine — load
//     average counts blocked threads. Tick-delta utilization is the honest number.
//
// "Memory pressure" is also a real kernel signal, not used/total, so it is read
// from kern.memorystatus_vm_pressure_level and reported separately.
//
// Top processes stay on our own `ps`: systeminformation's darwin implementation
// shells the same `ps` with nine more columns and takes its decayed pcpu verbatim,
// so there is nothing to gain and a 22ms spawn to lose.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import si from "systeminformation";
import { z } from "zod";

const run = promisify(execFile);
const ACTIVE_MS = 15_000; // a thread is running a turn, or the panel is open
const IDLE_MS = 60_000; // nobody is watching and nothing is working
const RETAIN_MS = 24 * 60 * 60 * 1000;
const PRIMARY_FALLBACK_ID = "__primary__";
// End-to-end budget: terminal creation, the sampler script (~5 s on macOS,
// most of it the two top samples), and draining the transcript.
const REMOTE_COMMAND_TIMEOUT_MS = 20_000;

const sampleShape = z.object({
  ts: z.number(),
  cpuPct: z.number(), // real utilization, 0..100
  load1: z.number(),
  load5: z.number(),
  cpuCount: z.number(),
  memTotalMb: z.number(),
  memUsedMb: z.number(),
  memUsedFrac: z.number(), // used/total — NOT "pressure"
  pressureLevel: z.number(), // kernel: 1 normal, 2 warn, 4 critical
  swapUsedMb: z.number(),
  diskTotalGb: z.number(),
  diskUsedGb: z.number(),
});
type Sample = z.infer<typeof sampleShape>;

const procShape = z.object({
  pid: z.number(),
  cpu: z.number(),
  memMb: z.number(),
  command: z.string(),
});

const machineShape = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["connected", "disconnected"]),
  isPrimary: z.boolean(),
});

const machineInput = z.object({ hostId: z.string().min(1).optional() }).strict().nullable();

export const rpcContract = defineRpcContract({
  machines: {
    input: z.null(),
    output: z.object({ machines: z.array(machineShape), primaryHostId: z.string() }),
  },
  current: {
    input: machineInput,
    output: z.object({
      sample: sampleShape.nullable(),
      topCpu: z.array(procShape),
      topMem: z.array(procShape),
      uptime: z.string(),
      stale: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  history: {
    input: z.object({ hostId: z.string().min(1).optional(), minutes: z.number().int().min(5).max(1440) }).strict(),
    output: z.object({ samples: z.array(sampleShape) }),
  },
  // The panel calls this while mounted so the sampler knows someone is watching.
  watching: { input: machineInput, output: z.object({ ok: z.boolean() }) },
  // Homepage-tiles visibility. Stored by the plugin itself (not the host's
  // settings page) so the panel's toggle takes effect the moment it is clicked.
  homeVisibility: {
    input: z.null(),
    output: z.object({ showOnHomepage: z.boolean() }),
  },
  setHomeVisibility: {
    input: z.object({ showOnHomepage: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

async function pressureLevel(): Promise<number> {
  try {
    const { stdout } = await run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    return Number(stdout.trim()) || 1;
  } catch {
    return 1; // non-macOS or unavailable: report normal rather than alarm
  }
}

async function topProcesses() {
  const { stdout } = await run("/bin/ps", ["axo", "pid=,pcpu=,rss=,comm="]);
  const procs = stdout
    .trim()
    .split("\n")
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        cpu: Number(m[2]),
        memMb: Math.round(Number(m[3]) / 1024),
        command: m[4]!.split("/").pop()!.slice(0, 48),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return {
    topCpu: [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, 8),
    topMem: [...procs].sort((a, b) => b.memMb - a.memMb).slice(0, 8),
  };
}

const REMOTE_SAMPLE_SCRIPT = String.raw`
set -eu
platform=$(uname -s)
if [ "$platform" = "Darwin" ]; then
  cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
  cpu_pct=$(top -l 2 -n 0 -s 1 2>/dev/null | awk '/CPU usage/ { idle=$7 } END { gsub(/%/, "", idle); if (idle == "") idle=100; printf "%.1f", 100-idle }')
  loads=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')
  load1=$(printf '%s\n' "$loads" | awk '{print $1+0}')
  load5=$(printf '%s\n' "$loads" | awk '{print $2+0}')
  mem_total_kb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 ))
  mem_used_kb=$(vm_stat 2>/dev/null | awk '
    NR==1 { gsub(/[^0-9]/, "", $0); page=$0+0; next }
    /Anonymous pages:/ { anon=$3 }
    /Pages active:/ { active=$3 }
    /Pages inactive:/ { inactive=$3 }
    /Pages purgeable:/ { purgeable=$3 }
    /Pages wired down:/ { wired=$4 }
    /Pages occupied by compressor:/ { compressed=$5 }
    END {
      gsub(/\./, "", anon); gsub(/\./, "", active); gsub(/\./, "", inactive);
      gsub(/\./, "", purgeable); gsub(/\./, "", wired); gsub(/\./, "", compressed);
      if (!anon) anon=active+inactive;
      used=(anon-purgeable+wired+compressed)*page/1024;
      if (used < 0) used = 0;
      printf "%.0f", used
    }')
  pressure=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 1)
  swap_used_kb=$(sysctl -n vm.swapusage 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="used") { v=$(i+2); sub(/M$/, "", v); printf "%.0f", v*1024 } }')
else
  cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
  cpu_pct=$(top -bn2 -d 0.2 2>/dev/null | awk '/^%Cpu/ { idle=$8 } END { if (idle == "") idle=100; printf "%.1f", 100-idle }')
  load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
  load5=$(awk '{print $2}' /proc/loadavg 2>/dev/null || echo 0)
  mem_total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  mem_available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  mem_used_kb=$((mem_total_kb-mem_available_kb))
  pressure=1
  swap_total_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  swap_free_kb=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  swap_used_kb=$((swap_total_kb-swap_free_kb))
fi
disk_path=/
if [ "$platform" = "Darwin" ] && [ -d /System/Volumes/Data ]; then
  disk_path=/System/Volumes/Data
fi
disk=$(df -k "$disk_path" 2>/dev/null | tail -n 1)
disk_total_kb=$(printf '%s\n' "$disk" | awk '{print $2+0}')
disk_used_kb=$(printf '%s\n' "$disk" | awk '{print $3+0}')
echo __BB_SYSTEM_BEGIN__
echo "cpu_pct=$cpu_pct"
echo "cpu_count=$cpu_count"
echo "load1=$load1"
echo "load5=$load5"
echo "mem_total_kb=$mem_total_kb"
echo "mem_used_kb=$mem_used_kb"
echo "pressure=$pressure"
echo "swap_used_kb=$swap_used_kb"
echo "disk_total_kb=$disk_total_kb"
echo "disk_used_kb=$disk_used_kb"
printf 'uptime=%s\n' "$(uptime 2>/dev/null || true)"
ps -axo pid=,pcpu=,rss=,comm= 2>/dev/null | sort -k2,2nr | head -n 8 | while read -r pid cpu rss command; do
  printf 'cpu_proc=%s|%s|%s|%s\n' "$pid" "$cpu" "$rss" "$command"
done
ps -axo pid=,pcpu=,rss=,comm= 2>/dev/null | sort -k3,3nr | head -n 8 | while read -r pid cpu rss command; do
  printf 'mem_proc=%s|%s|%s|%s\n' "$pid" "$cpu" "$rss" "$command"
done
echo __BB_SYSTEM_END__
`;

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function decodeTerminalOutput(chunks: { dataBase64: string }[]) {
  return chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
}

type CurrentData = {
  sample: Sample;
  topCpu: z.infer<typeof procShape>[];
  topMem: z.infer<typeof procShape>[];
  uptime: string;
};

/**
 * Which commit is this PROCESS running? (MX-139/MX-141)
 *
 * bb bundles a `path:` plugin FROM SOURCE at reload, so a revision read here — at module
 * load, the same moment — is by construction the code now executing. Nothing else can say:
 * `bb plugin list` prints `running` and the source path but no revision, `bb plugin source`
 * has none to record for a path: source, and dist/ is NOT the loaded artifact (its mtime was
 * measured lying by 15 minutes). So a checkout can sit clean on main, every drift check
 * green, while the process runs something older.
 *
 * Synchronous on purpose: the value must be fixed before anything can observe it, and it is
 * one git call per load. Failure yields rev: null rather than a guess — a tarball install has
 * no git dir, and that must stay distinguishable from a real mismatch so a checker reports
 * UNKNOWN rather than OK. `dirty` rides along because a bundle built from an edited tree
 * matches NO commit, and comparing revisions alone would call that a match.
 */
const BUILD_STAMP: { rev: string | null; dirty: boolean | null; sourceDir: string; loadedAt: string; why: string | null } = (() => {
  const sourceDir = import.meta.dirname;
  const loadedAt = new Date().toISOString();
  try {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", sourceDir, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    return { rev: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]).length > 0, sourceDir, loadedAt, why: null };
  } catch (e) {
    return { rev: null, dirty: null, sourceDir, loadedAt, why: e instanceof Error ? e.message : String(e) };
  }
})();

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  // Append-only migrations. v1 shipped mem_pressure (a misnomer for used/total)
  // and no cpu_pct; both are corrected by adding columns rather than rewriting
  // history, so pre-migration rows simply carry NULL for the new fields.
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS samples (
       ts INTEGER PRIMARY KEY,
       load1 REAL, load5 REAL, cpu_count INTEGER,
       mem_total_mb INTEGER, mem_used_mb INTEGER, mem_pressure REAL,
       swap_used_mb INTEGER, disk_total_gb INTEGER, disk_used_gb INTEGER
     )`,
    `ALTER TABLE samples ADD COLUMN cpu_pct REAL`,
    `ALTER TABLE samples ADD COLUMN pressure_level INTEGER`,
    `CREATE TABLE IF NOT EXISTS samples_by_host (
       host_id TEXT NOT NULL,
       ts INTEGER NOT NULL,
       load1 REAL, load5 REAL, cpu_count INTEGER,
       mem_total_mb INTEGER, mem_used_mb INTEGER, mem_pressure REAL,
       swap_used_mb INTEGER, disk_total_gb INTEGER, disk_used_gb INTEGER,
       cpu_pct REAL, pressure_level INTEGER,
       PRIMARY KEY (host_id, ts)
     )`,
  ]);

  const config = await bb.sdk.system.config();
  const primaryHostId = config.primaryHostId ?? PRIMARY_FALLBACK_ID;

  // Import the legacy single-machine table exactly once. If the first load had
  // no resolved primary ID, merge that fallback bucket into the real primary
  // later instead of copying the same history under every changed host ID.
  const legacyImportKey = "legacy-history-import-host";
  const importedHostId = await bb.storage.kv.get<string>(legacyImportKey);
  const copyLegacy = db.prepare(
    `INSERT OR IGNORE INTO samples_by_host
       (host_id, ts, load1, load5, cpu_count, mem_total_mb, mem_used_mb,
        mem_pressure, swap_used_mb, disk_total_gb, disk_used_gb, cpu_pct, pressure_level)
     SELECT ?, ts, load1, load5, cpu_count, mem_total_mb, mem_used_mb,
            mem_pressure, swap_used_mb, disk_total_gb, disk_used_gb, cpu_pct, pressure_level
     FROM samples`,
  );
  if (importedHostId === undefined) {
    copyLegacy.run(primaryHostId);
    await bb.storage.kv.set(legacyImportKey, primaryHostId);
  } else if (importedHostId === PRIMARY_FALLBACK_ID && primaryHostId !== PRIMARY_FALLBACK_ID) {
    const mergeFallback = db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO samples_by_host SELECT ?, ts, load1, load5, cpu_count,
           mem_total_mb, mem_used_mb, mem_pressure, swap_used_mb, disk_total_gb,
           disk_used_gb, cpu_pct, pressure_level
         FROM samples_by_host WHERE host_id = ?`,
      ).run(primaryHostId, PRIMARY_FALLBACK_ID);
      db.prepare(`DELETE FROM samples_by_host WHERE host_id = ?`).run(PRIMARY_FALLBACK_ID);
    });
    mergeFallback();
    await bb.storage.kv.set(legacyImportKey, primaryHostId);
  }

  // Hardware constants: read once at load, not re-sampled every tick.
  const [cpuInfo, memInfo] = await Promise.all([si.cpu(), si.mem()]);
  const cpuCount = cpuInfo.physicalCores * 0 + (cpuInfo.cores || 1);
  const memTotalMb = Math.round(memInfo.total / 1048576);

  async function takeLocalSample(): Promise<Sample> {
    const [load, mem, fs, pressure] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      pressureLevel(),
    ]);
    const dataVol =
      fs.find((f) => f.mount === "/System/Volumes/Data") ?? fs.find((f) => f.mount === "/") ?? fs[0];
    return {
      ts: Date.now(),
      cpuPct: Number(load.currentLoad.toFixed(1)),
      // si reports avgLoad PER CORE; store the raw 1-minute load so the number
      // matches what `uptime` prints.
      load1: Number((((load.avgLoad ?? 0) * cpuCount)).toFixed(2)),
      load5: Number((((load.avgLoad ?? 0) * cpuCount)).toFixed(2)),
      cpuCount,
      memTotalMb,
      memUsedMb: Math.round(mem.active / 1048576),
      memUsedFrac: mem.total ? mem.active / mem.total : 0,
      pressureLevel: pressure,
      swapUsedMb: Math.round((mem.swapused ?? 0) / 1048576),
      diskTotalGb: dataVol ? Math.round(dataVol.size / 1073741824) : 0,
      diskUsedGb: dataVol ? Math.round(dataVol.used / 1073741824) : 0,
    };
  }

  const insert = (hostId: string, s: Sample) => {
    db.prepare(
      `INSERT OR REPLACE INTO samples_by_host
         (host_id, ts, load1, load5, cpu_count, mem_total_mb, mem_used_mb, mem_pressure,
          swap_used_mb, disk_total_gb, disk_used_gb, cpu_pct, pressure_level)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      hostId, s.ts, s.load1, s.load5, s.cpuCount, s.memTotalMb, s.memUsedMb, s.memUsedFrac,
      s.swapUsedMb, s.diskTotalGb, s.diskUsedGb, s.cpuPct, s.pressureLevel,
    );
    db.prepare(`DELETE FROM samples_by_host WHERE ts < ?`).run(Date.now() - RETAIN_MS);
  };

  const rowToSample = (r: Record<string, unknown>): Sample => {
    const count = Number(r.cpu_count) || 1;
    const load1 = Number(r.load1);
    return {
      ts: Number(r.ts),
      // Pre-migration rows have no cpu_pct; fall back to the old (wrong but
      // present) load-derived figure so the sparkline has no hole.
      cpuPct: r.cpu_pct === null || r.cpu_pct === undefined
        ? Math.min(100, (load1 / count) * 100)
        : Number(r.cpu_pct),
      load1,
      load5: Number(r.load5),
      cpuCount: count,
      memTotalMb: Number(r.mem_total_mb),
      memUsedMb: Number(r.mem_used_mb),
      memUsedFrac: Number(r.mem_pressure),
      pressureLevel: r.pressure_level == null ? 1 : Number(r.pressure_level),
      swapUsedMb: Number(r.swap_used_mb),
      diskTotalGb: Number(r.disk_total_gb),
      diskUsedGb: Number(r.disk_used_gb),
    };
  };

  const latest = (hostId: string): Sample | null => {
    const r = db.prepare(`SELECT * FROM samples_by_host WHERE host_id = ? ORDER BY ts DESC LIMIT 1`).get(hostId) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToSample(r) : null;
  };

  const remoteCurrent = new Map<string, Omit<CurrentData, "sample">>();
  const sampling = new Map<string, Promise<CurrentData>>();
  const lastAttemptAt = new Map<string, number>();
  const backgroundSamples = new Set<Promise<void>>();

  const parseProcess = (value: string) => {
    const [pid, cpu, rss, ...command] = value.split("|");
    return {
      pid: Number(pid),
      cpu: Number(cpu),
      memMb: Math.round(Number(rss) / 1024),
      command: command.join("|").split("/").pop()!.slice(0, 48),
    };
  };

  function abortableDelay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  // Combine the caller's abort signal with a deadline so every terminal call
  // is itself time-bounded; without AbortSignal.timeout/any (older runtimes)
  // this degrades to the caller's signal alone, still bounded by bb's own
  // terminal-operation timeouts.
  function signalWithTimeout(signal: AbortSignal | undefined, remainingMs: number): AbortSignal {
    if (typeof AbortSignal.timeout !== "function") return signal ?? new AbortController().signal;
    const timeout = AbortSignal.timeout(Math.max(1, remainingMs));
    return signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : signal ?? timeout;
  }

  async function takeRemoteSample(hostId: string, signal?: AbortSignal): Promise<CurrentData> {
    // Run the sampler as a one-shot command instead of pasting it into a
    // reused interactive shell: on macOS a multi-line terminals.input write
    // drops bytes, so the shell never sees the full script. Each sample gets a
    // fresh terminal, so failed hosts cannot churn a long-lived remote shell.
    // base64 -D (macOS) vs -d (GNU) is handled by trying both. The trailing
    // `cat` holds the session open (its stdin is the PTY, which never receives
    // input) until the drain loop has captured the full transcript, so output
    // cannot become unavailable mid-read; the finally block reaps the
    // terminal — and with it any hung command — afterwards.
    const payload = Buffer.from(REMOTE_SAMPLE_SCRIPT, "utf8").toString("base64");
    const command = [
      "printf %s", shellQuote(payload),
      "| { base64 -D 2>/dev/null || base64 -d; }",
      "| /bin/sh; cat >/dev/null",
    ].join(" ");
    const deadline = Date.now() + REMOTE_COMMAND_TIMEOUT_MS;
    const terminal = await bb.sdk.terminals.create({
      cols: 200,
      rows: 50,
      scope: { kind: "host_path", hostId, cwd: null },
      start: { mode: "command", command: "/bin/sh -c " + shellQuote(command) },
      title: "System metrics",
    });
    let text = "";
    let nextSeq = 0;
    try {
      let state = terminal;
      while (state.status === "starting") {
        if (signal?.aborted) throw new Error("sampling cancelled");
        if (Date.now() >= deadline) throw new Error("metric terminal timed out");
        await abortableDelay(Math.min(150, deadline - Date.now()), signal);
        state = await (async () => {
          try {
            return await bb.sdk.terminals.get({
              terminalId: terminal.id,
              signal: signalWithTimeout(signal, deadline - Date.now()),
            });
          } catch (error) {
            if (signal?.aborted) throw new Error("sampling cancelled");
            if (Date.now() >= deadline) throw new Error("metric terminal timed out");
            throw error;
          }
        })();
      }
      // The blocking cat keeps the session running until we close it, so a
      // session that is no longer running never has a complete transcript.
      if (state.status !== "running") throw new Error("metric terminal did not stay running");
      while (!text.includes("__BB_SYSTEM_END__")) {
        if (signal?.aborted) throw new Error("sampling cancelled");
        if (Date.now() >= deadline) throw new Error("metric command timed out");
        const output = await (async () => {
          try {
            return await bb.sdk.terminals.output({
              terminalId: terminal.id,
              sinceSeq: nextSeq,
              limitChunks: 500,
              signal: signalWithTimeout(signal, deadline - Date.now()),
            });
          } catch (error) {
            if (signal?.aborted) throw new Error("sampling cancelled");
            if (Date.now() >= deadline) throw new Error("metric command timed out");
            throw error;
          }
        })();
        text += decodeTerminalOutput(output.chunks);
        nextSeq = output.nextSeq;
        if (!text.includes("__BB_SYSTEM_END__")) await abortableDelay(Math.min(150, deadline - Date.now()), signal);
      }
      const match = text.match(/__BB_SYSTEM_BEGIN__\r?\n([\s\S]*?)__BB_SYSTEM_END__/);
      if (!match) throw new Error("metric command returned no data");
      const values = new Map<string, string>();
      const topCpu: z.infer<typeof procShape>[] = [];
      const topMem: z.infer<typeof procShape>[] = [];
      for (const rawLine of match[1]!.split(/\r?\n/)) {
        const line = rawLine.trim();
        const at = line.indexOf("=");
        if (at < 1) continue;
        const key = line.slice(0, at);
        const value = line.slice(at + 1);
        if (key === "cpu_proc") topCpu.push(parseProcess(value));
        else if (key === "mem_proc") topMem.push(parseProcess(value));
        else values.set(key, value);
      }
      const num = (key: string) => Number(values.get(key)) || 0;
      const memTotalMb = Math.round(num("mem_total_kb") / 1024);
      const memUsedMb = Math.round(num("mem_used_kb") / 1024);
      const sample: Sample = {
        ts: Date.now(),
        cpuPct: Math.min(100, Math.max(0, num("cpu_pct"))),
        load1: num("load1"),
        load5: num("load5"),
        cpuCount: Math.max(1, num("cpu_count")),
        memTotalMb,
        memUsedMb,
        memUsedFrac: memTotalMb ? memUsedMb / memTotalMb : 0,
        pressureLevel: num("pressure") || 1,
        swapUsedMb: Math.round(num("swap_used_kb") / 1024),
        diskTotalGb: Math.round(num("disk_total_kb") / 1048576),
        diskUsedGb: Math.round(num("disk_used_kb") / 1048576),
      };
      return { sample, topCpu, topMem, uptime: values.get("uptime") ?? "" };
    } finally {
      // Always reap the one-shot terminal — success, failure, or abort. On
      // success the blocking cat is still holding the session open; on
      // timeout or shutdown this is what kills the hung command. The abort
      // guard is deliberately absent: a service reload is exactly when a
      // stranded remote shell must not be left behind.
      void bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
    }
  }

  bb.onDispose(async () => {
    await Promise.race([
      Promise.allSettled([...backgroundSamples]),
      new Promise((resolve) => setTimeout(resolve, 2_500)),
    ]);
  });

  async function sampleHost(hostId: string, signal?: AbortSignal): Promise<CurrentData> {
    const running = sampling.get(hostId);
    if (running) return running;
    lastAttemptAt.set(hostId, Date.now());
    const promise = (async () => {
      let current: CurrentData;
      if (hostId === primaryHostId) {
        const [sample, processes, uptimeResult] = await Promise.all([
          takeLocalSample(),
          topProcesses(),
          run("/usr/bin/uptime", []),
        ]);
        current = { sample, ...processes, uptime: uptimeResult.stdout.trim() };
      } else {
        current = await takeRemoteSample(hostId, signal);
      }
      insert(hostId, current.sample);
      remoteCurrent.set(hostId, {
        topCpu: current.topCpu,
        topMem: current.topMem,
        uptime: current.uptime,
      });
      bb.realtime.publish("system.sample", {
        hostId,
        isPrimary: hostId === primaryHostId,
        at: current.sample.ts,
      });
      return current;
    })().finally(() => sampling.delete(hostId));
    sampling.set(hostId, promise);
    return promise;
  }

  // Adaptive cadence. A fixed short interval that spawns work every tick fights
  // macOS timer coalescing and keeps cores out of deep idle for nothing; App Nap
  // stretches it silently when bb is backgrounded anyway. Sample fast only when
  // the data is actually wanted: a thread is running, or the panel is mounted.
  let activeThreads = 0;
  const watchingUntil = new Map<string, number>();
  bb.events.on("thread.active", () => { activeThreads++; });
  bb.events.on("thread.idle", () => { activeThreads = Math.max(0, activeThreads - 1); });
  bb.events.on("thread.failed", () => { activeThreads = Math.max(0, activeThreads - 1); });
  const interval = () =>
    activeThreads > 0 || [...watchingUntil.values()].some((until) => Date.now() < until)
      ? ACTIVE_MS
      : IDLE_MS;

  const unsubscribeHosts = bb.sdk.subscribe({
    event: "host:changed",
    callback: () => bb.realtime.publish("system.machines", { at: Date.now() }),
  });
  bb.onDispose(unsubscribeHosts);

  bb.background.service("sampler", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const now = Date.now();
          const hosts = await bb.sdk.hosts.list({ signal });
          const hostIds = new Set([
            primaryHostId,
            ...hosts.filter((host) => host.status === "connected").map((host) => host.id),
          ]);
          for (const [hostId, until] of watchingUntil) {
            if (until <= now) watchingUntil.delete(hostId);
          }
          let availableSlots = Math.max(0, 4 - backgroundSamples.size);
          for (const hostId of hostIds) {
            if (availableSlots === 0) break;
            const watched = (watchingUntil.get(hostId) ?? 0) > now;
            const cadence = watched || (hostId === primaryHostId && activeThreads > 0)
              ? ACTIVE_MS
              : IDLE_MS;
            const mostRecent = lastAttemptAt.get(hostId) ?? latest(hostId)?.ts ?? 0;
            if (now - mostRecent < cadence || sampling.has(hostId)) continue;
            availableSlots--;
            let task!: Promise<void>;
            task = sampleHost(hostId, signal)
              .then(() => undefined)
              .catch((error) => {
                if (!signal.aborted) {
                  bb.log.warn(`sample failed for ${hostId}: ${error instanceof Error ? error.message : error}`);
                }
              })
              .finally(() => backgroundSamples.delete(task));
            backgroundSamples.add(task);
          }
        } catch (e) {
          bb.log.warn(`sample failed: ${e instanceof Error ? e.message : e}`);
        }
        await new Promise((resolve) => {
          const t = setTimeout(resolve, interval());
          signal.addEventListener("abort", () => { clearTimeout(t); resolve(undefined); }, { once: true });
        });
      }
    },
  });

  bb.rpc.register(rpcContract, {
    async machines() {
      const hosts = await bb.sdk.hosts.list();
      const machines = hosts.map((host) => ({
        id: host.id,
        name: host.name,
        status: host.status,
        isPrimary: host.id === primaryHostId,
      }));
      if (!machines.some((machine) => machine.id === primaryHostId)) {
        machines.unshift({
          id: primaryHostId,
          name: "This machine",
          status: "connected",
          isPrimary: true,
        });
      }
      machines.sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) ||
          Number(b.status === "connected") - Number(a.status === "connected") ||
          a.name.localeCompare(b.name),
      );
      return { machines, primaryHostId };
    },
    async current(input) {
      const hostId = input?.hostId ?? primaryHostId;
      let sample = latest(hostId);
      let stale = false;
      let sampleError: string | null = null;
      let canSample = true;
      if (hostId !== primaryHostId) {
        try {
          const host = await bb.sdk.hosts.get({ hostId });
          if (host.status !== "connected") {
            stale = true;
            canSample = false;
            sampleError = `${host.name} is offline`;
          }
        } catch (error) {
          stale = true;
          canSample = false;
          sampleError = error instanceof Error ? error.message : "Machine is unavailable";
        }
      }
      if (canSample && (
        !sample ||
        Date.now() - sample.ts > ACTIVE_MS * 2 ||
        (hostId !== primaryHostId && !remoteCurrent.has(hostId))
      )) {
        try {
          return { ...(await sampleHost(hostId)), stale: false, error: null };
        } catch (error) {
          if (!sample) throw error;
          stale = true;
          sampleError = error instanceof Error ? error.message : "Machine sampling failed";
        }
      }
      const details = remoteCurrent.get(hostId);
      if (hostId === primaryHostId) {
        const [processes, uptimeResult] = await Promise.all([topProcesses(), run("/usr/bin/uptime", [])]);
        return {
          sample,
          ...processes,
          uptime: uptimeResult.stdout.trim(),
          stale,
          error: sampleError,
        };
      }
      return {
        sample,
        topCpu: details?.topCpu ?? [],
        topMem: details?.topMem ?? [],
        uptime: details?.uptime ?? "",
        stale,
        error: sampleError,
      };
    },
    history({ hostId = primaryHostId, minutes }) {
      const rows = db
        .prepare(`SELECT * FROM samples_by_host WHERE host_id = ? AND ts >= ? ORDER BY ts`)
        .all(hostId, Date.now() - minutes * 60_000) as Record<string, unknown>[];
      return { samples: rows.map(rowToSample) };
    },
    watching(input) {
      const hostId = input?.hostId ?? primaryHostId;
      watchingUntil.set(hostId, Date.now() + 90_000);
      return { ok: true };
    },
    async homeVisibility() {
      const raw = await bb.storage.kv.get<string>("showOnHomepage");
      return { showOnHomepage: raw !== "0" };
    },
    async setHomeVisibility(input) {
      await bb.storage.kv.set("showOnHomepage", input.showOnHomepage ? "1" : "0");
      bb.realtime.publish("system.home-visibility", { showOnHomepage: input.showOnHomepage });
      return { ok: true };
    },
  });

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const bar = (frac: number, width = 20) => {
    const filled = Math.round(Math.min(1, Math.max(0, frac)) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  };
  const PRESSURE = { 1: "normal", 2: "warning", 4: "critical" } as Record<number, string>;

  bb.cli.register({
    name: "system",
    summary: "System overview: CPU load, memory, disk, top processes",
    commands: [
      { name: "overview", summary: "Current CPU/memory/disk snapshot (default)", usage: "bb system [overview]" },
      { name: "top", summary: "Top processes by CPU and memory", usage: "bb system top" },
      { name: "history", summary: "Compact trend for the last N minutes", usage: "bb system history [minutes=60]" },
      {
        name: "build",
        summary: "Which commit this RUNNING process was loaded from (not the checkout)",
        usage: "bb system build [--json]",
      },
    ],
    async run(argv) {
      const cmd = argv[0] ?? "overview";

      // Answered FIRST, before anything shells out or reads state: "what is running" must
      // stay answerable when the thing running is broken.
      if (cmd === "build") {
        if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(BUILD_STAMP) };
        const dirty = BUILD_STAMP.dirty === null ? "" : BUILD_STAMP.dirty ? " +dirty" : "";
        const why = BUILD_STAMP.why ? `  (${BUILD_STAMP.why})` : "";
        return {
          exitCode: 0,
          stdout: `loaded ${BUILD_STAMP.rev ?? "unknown"}${dirty} from ${BUILD_STAMP.sourceDir} at ${BUILD_STAMP.loadedAt}${why}`,
        };
      }
      if (cmd === "top") {
        const { topCpu, topMem } = await topProcesses();
        const fmt = (p: { pid: number; cpu: number; memMb: number; command: string }) =>
          `${String(p.pid).padStart(6)}  ${p.cpu.toFixed(1).padStart(5)}%  ${String(p.memMb).padStart(6)}MB  ${p.command}`;
        return {
          exitCode: 0,
          stdout: ["BY CPU:", ...topCpu.map(fmt), "", "BY MEMORY:", ...topMem.map(fmt)].join("\n"),
        };
      }
      if (cmd === "history") {
        const minutes = Math.min(1440, parseInt(argv[1] ?? "60", 10) || 60);
        const rows = db
          .prepare(`SELECT * FROM samples_by_host WHERE host_id = ? AND ts >= ? ORDER BY ts`)
          .all(primaryHostId, Date.now() - minutes * 60_000) as Record<string, unknown>[];
        if (!rows.length) return { exitCode: 0, stdout: "no samples yet" };
        const step = Math.max(1, Math.floor(rows.length / 24));
        const lines: string[] = [];
        for (let i = 0; i < rows.length; i += step) {
          const s = rowToSample(rows[i]!);
          lines.push(
            `${new Date(s.ts).toTimeString().slice(0, 5)}  cpu ${bar(s.cpuPct / 100, 12)} ${String(Math.round(s.cpuPct)).padStart(3)}%  mem ${bar(s.memUsedFrac, 12)} ${pct(s.memUsedFrac)}`,
          );
        }
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      const s = latest(primaryHostId) ?? (await takeLocalSample());
      const { stdout: up } = await run("/usr/bin/uptime", []);
      return {
        exitCode: 0,
        stdout: [
          `CPU   ${bar(s.cpuPct / 100)}  ${s.cpuPct.toFixed(1)}% of ${s.cpuCount} cores  (load ${s.load1.toFixed(2)})`,
          `MEM   ${bar(s.memUsedFrac)}  ${(s.memUsedMb / 1024).toFixed(1)} / ${(s.memTotalMb / 1024).toFixed(0)} GB used` +
            (s.swapUsedMb > 0 ? `  · swap ${(s.swapUsedMb / 1024).toFixed(1)} GB` : "") +
            `  · pressure ${PRESSURE[s.pressureLevel] ?? s.pressureLevel}`,
          `DISK  ${bar(s.diskUsedGb / (s.diskTotalGb || 1))}  ${s.diskUsedGb} / ${s.diskTotalGb} GB on the data volume`,
          up.trim(),
        ].join("\n"),
      };
    },
  });

  bb.log.info("system plugin loaded");
}

const mx222NegativeControl: number = "not a number";
void mx222NegativeControl;
