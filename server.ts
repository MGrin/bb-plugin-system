// bb-plugin-system — live system overview for this machine.
//
// A background sampler records CPU load, memory pressure, disk usage, and the
// top processes every SAMPLE_MS into the plugin database (ring buffer), and the
// frontend panel / `bb system` CLI read from it. Sampling uses cheap macOS
// primitives (sysctl, vm_stat, df, ps) — no third-party binaries.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const run = promisify(execFile);
const SAMPLE_MS = 15_000;
const RETAIN_SAMPLES = 5_760; // 24h at 15s

const sampleShape = z.object({
  ts: z.number(),
  load1: z.number(),
  load5: z.number(),
  cpuCount: z.number(),
  memTotalMb: z.number(),
  memUsedMb: z.number(),
  memPressure: z.number(), // used/total 0..1 (active+wired+compressed)
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
});

async function takeSample(): Promise<Sample> {
  const [loadOut, memsizeOut, cpuOut, vmOut, dfOut, swapOut] = await Promise.all([
    run("/usr/sbin/sysctl", ["-n", "vm.loadavg"]),
    run("/usr/sbin/sysctl", ["-n", "hw.memsize"]),
    run("/usr/sbin/sysctl", ["-n", "hw.ncpu"]),
    run("/usr/bin/vm_stat", []),
    run("/bin/df", ["-k", "/System/Volumes/Data"]),
    run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
  ]);
  const load = loadOut.stdout.replace(/[{}]/g, "").trim().split(/\s+/).map(Number);
  const memTotal = Number(memsizeOut.stdout.trim());
  const pageMatch = vmOut.stdout.match(/page size of (\d+)/);
  const page = pageMatch ? Number(pageMatch[1]) : 16384;
  const vm: Record<string, number> = {};
  for (const line of vmOut.stdout.split("\n")) {
    const m = line.match(/^([A-Za-z -]+):\s+(\d+)/);
    if (m) vm[m[1]!.trim()] = Number(m[2]);
  }
  const usedPages =
    (vm["Pages active"] ?? 0) + (vm["Pages wired down"] ?? 0) + (vm["Pages occupied by compressor"] ?? 0);
  const dfLine = dfOut.stdout.trim().split("\n").pop()!.split(/\s+/);
  const swapMatch = swapOut.stdout.match(/used = ([\d.]+)M/);
  return {
    ts: Date.now(),
    load1: load[0] ?? 0,
    load5: load[1] ?? 0,
    cpuCount: Number(cpuOut.stdout.trim()),
    memTotalMb: Math.round(memTotal / 1048576),
    memUsedMb: Math.round((usedPages * page) / 1048576),
    memPressure: Math.min(1, (usedPages * page) / memTotal),
    swapUsedMb: Math.round(Number(swapMatch?.[1] ?? 0)),
    diskTotalGb: Math.round(Number(dfLine[1]) / 1048576),
    diskUsedGb: Math.round(Number(dfLine[2]) / 1048576),
  };
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
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS samples (
       ts INTEGER PRIMARY KEY,
       load1 REAL, load5 REAL, cpu_count INTEGER,
       mem_total_mb INTEGER, mem_used_mb INTEGER, mem_pressure REAL,
       swap_used_mb INTEGER, disk_total_gb INTEGER, disk_used_gb INTEGER
     )`,
  ]);

  const insert = (s: Sample) => {
    db.prepare(
      `INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(s.ts, s.load1, s.load5, s.cpuCount, s.memTotalMb, s.memUsedMb, s.memPressure, s.swapUsedMb, s.diskTotalGb, s.diskUsedGb);
    db.prepare(
      `DELETE FROM samples WHERE ts < (SELECT MIN(ts) FROM (SELECT ts FROM samples ORDER BY ts DESC LIMIT ?))`,
    ).run(RETAIN_SAMPLES);
  };

  const rowToSample = (r: Record<string, unknown>): Sample => ({
    ts: Number(r.ts), load1: Number(r.load1), load5: Number(r.load5), cpuCount: Number(r.cpu_count),
    memTotalMb: Number(r.mem_total_mb), memUsedMb: Number(r.mem_used_mb), memPressure: Number(r.mem_pressure),
    swapUsedMb: Number(r.swap_used_mb), diskTotalGb: Number(r.disk_total_gb), diskUsedGb: Number(r.disk_used_gb),
  });

  const latest = (): Sample | null => {
    const r = db.prepare(`SELECT * FROM samples ORDER BY ts DESC LIMIT 1`).get() as
      | Record<string, unknown>
      | undefined;
    return r ? rowToSample(r) : null;
  };

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
          const t = setTimeout(resolve, SAMPLE_MS);
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
  });

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const bar = (frac: number, width = 20) => {
    const filled = Math.round(Math.min(1, Math.max(0, frac)) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  };

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
        const buckets = 24;
        const step = Math.max(1, Math.floor(rows.length / buckets));
        const lines = [];
        for (let i = 0; i < rows.length; i += step) {
          const s = rowToSample(rows[i]!);
          lines.push(
            `${new Date(s.ts).toTimeString().slice(0, 5)}  cpu ${bar(s.load1 / s.cpuCount, 12)} ${s.load1.toFixed(1)}  mem ${bar(s.memPressure, 12)} ${pct(s.memPressure)}`,
          );
        }
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      const s = latest() ?? (await takeSample());
      const { stdout: up } = await run("/usr/bin/uptime", []);
      return {
        exitCode: 0,
        stdout: [
          `CPU   ${bar(s.load1 / s.cpuCount)}  load ${s.load1.toFixed(2)} / ${s.cpuCount} cores (5m ${s.load5.toFixed(2)})`,
          `MEM   ${bar(s.memPressure)}  ${(s.memUsedMb / 1024).toFixed(1)} / ${(s.memTotalMb / 1024).toFixed(0)} GB used` +
            (s.swapUsedMb > 0 ? `  · swap ${(s.swapUsedMb / 1024).toFixed(1)} GB` : ""),
          `DISK  ${bar(s.diskUsedGb / s.diskTotalGb)}  ${s.diskUsedGb} / ${s.diskTotalGb} GB on /System/Volumes/Data`,
          up.trim(),
        ].join("\n"),
      };
    },
  });

  bb.log.info("system plugin loaded");
}
