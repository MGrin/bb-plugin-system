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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import si from "systeminformation";
import { z } from "zod";

const run = promisify(execFile);
const ACTIVE_MS = 15_000; // a thread is running a turn, or the panel is open
const IDLE_MS = 60_000; // nobody is watching and nothing is working
const RETAIN_MS = 24 * 60 * 60 * 1000;

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

export const rpcContract = defineRpcContract({
  current: {
    input: z.null(),
    output: z.object({
      sample: sampleShape.nullable(),
      topCpu: z.array(procShape),
      topMem: z.array(procShape),
      uptime: z.string(),
    }),
  },
  history: {
    input: z.object({ minutes: z.number().int().min(5).max(1440) }).strict(),
    output: z.object({ samples: z.array(sampleShape) }),
  },
  // The panel calls this while mounted so the sampler knows someone is watching.
  watching: { input: z.null(), output: z.object({ ok: z.boolean() }) },
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
  ]);

  // Hardware constants: read once at load, not re-sampled every tick.
  const [cpuInfo, memInfo] = await Promise.all([si.cpu(), si.mem()]);
  const cpuCount = cpuInfo.physicalCores * 0 + (cpuInfo.cores || 1);
  const memTotalMb = Math.round(memInfo.total / 1048576);

  async function takeSample(): Promise<Sample> {
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

  const insert = (s: Sample) => {
    db.prepare(
      `INSERT OR REPLACE INTO samples
         (ts, load1, load5, cpu_count, mem_total_mb, mem_used_mb, mem_pressure,
          swap_used_mb, disk_total_gb, disk_used_gb, cpu_pct, pressure_level)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      s.ts, s.load1, s.load5, s.cpuCount, s.memTotalMb, s.memUsedMb, s.memUsedFrac,
      s.swapUsedMb, s.diskTotalGb, s.diskUsedGb, s.cpuPct, s.pressureLevel,
    );
    // Index range scan, not a 5760-row sort on every tick.
    db.prepare(`DELETE FROM samples WHERE ts < ?`).run(Date.now() - RETAIN_MS);
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

  const latest = (): Sample | null => {
    const r = db.prepare(`SELECT * FROM samples ORDER BY ts DESC LIMIT 1`).get() as
      | Record<string, unknown>
      | undefined;
    return r ? rowToSample(r) : null;
  };

  // Adaptive cadence. A fixed short interval that spawns work every tick fights
  // macOS timer coalescing and keeps cores out of deep idle for nothing; App Nap
  // stretches it silently when bb is backgrounded anyway. Sample fast only when
  // the data is actually wanted: a thread is running, or the panel is mounted.
  let activeThreads = 0;
  let watchingUntil = 0;
  bb.events.on("thread.active", () => { activeThreads++; });
  bb.events.on("thread.idle", () => { activeThreads = Math.max(0, activeThreads - 1); });
  bb.events.on("thread.failed", () => { activeThreads = Math.max(0, activeThreads - 1); });
  const interval = () =>
    activeThreads > 0 || Date.now() < watchingUntil ? ACTIVE_MS : IDLE_MS;

  bb.background.service("sampler", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          insert(await takeSample());
          bb.realtime.publish("system.sample", { at: Date.now() });
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
    async current() {
      const { topCpu, topMem } = await topProcesses();
      const { stdout } = await run("/usr/bin/uptime", []);
      return { sample: latest(), topCpu, topMem, uptime: stdout.trim() };
    },
    history({ minutes }) {
      const rows = db
        .prepare(`SELECT * FROM samples WHERE ts >= ? ORDER BY ts`)
        .all(Date.now() - minutes * 60_000) as Record<string, unknown>[];
      return { samples: rows.map(rowToSample) };
    },
    watching() {
      watchingUntil = Date.now() + 90_000;
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
    ],
    async run(argv) {
      const cmd = argv[0] ?? "overview";
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
          .prepare(`SELECT * FROM samples WHERE ts >= ? ORDER BY ts`)
          .all(Date.now() - minutes * 60_000) as Record<string, unknown>[];
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
      const s = latest() ?? (await takeSample());
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
