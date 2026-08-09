// bb-plugin-system frontend — System panel + homepage tiles.
import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Sample = {
  ts: number; cpuPct: number; load1: number; load5: number; cpuCount: number;
  memTotalMb: number; memUsedMb: number; memUsedFrac: number; pressureLevel: number;
  swapUsedMb: number; diskTotalGb: number; diskUsedGb: number;
};
type Current = {
  sample: Sample | null;
  topCpu: { pid: number; cpu: number; memMb: number; command: string }[];
  topMem: { pid: number; cpu: number; memMb: number; command: string }[];
  uptime: string;
};
type Hist = { samples: Sample[] };

const PRESSURE: Record<number, string> = { 1: "normal", 2: "warning", 4: "critical" };

function Meter({ frac, tone }: { frac: number; tone: "ok" | "warn" | "hot" }) {
  const cls = tone === "hot" ? "bg-destructive" : tone === "warn" ? "bg-primary/70" : "bg-primary";
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.min(100, Math.round(frac * 100))}%` }} />
    </div>
  );
}

function Tile(props: { label: string; value: string; sub: string; frac: number; hot?: boolean }) {
  const tone = props.hot || props.frac >= 0.9 ? "hot" : props.frac >= 0.75 ? "warn" : "ok";
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{props.label}</div>
      <div className="text-2xl font-semibold text-foreground">{props.value}</div>
      <Meter frac={props.frac} tone={tone} />
      <div className="text-xs text-muted-foreground">{props.sub}</div>
    </div>
  );
}

function Spark({ points, title, max }: { points: number[]; title: string; max: number }) {
  if (points.length < 2) return null;
  const w = 280, h = 48;
  const top = Math.max(max, ...points, 0.01);
  const path = points
    .map((v, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - (v / top) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground mb-1">{title}</div>
      <svg width={w} height={h} className="text-primary w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={title}>
        <polyline points={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function ProcTable({ title, rows, metric }: { title: string; rows: Current["topCpu"]; metric: "cpu" | "mem" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((p) => (
            <tr key={p.pid} className="border-t border-border/50 first:border-0">
              <td className="py-1 pr-2 text-foreground truncate max-w-[180px]">{p.command}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">
                {metric === "cpu" ? `${p.cpu.toFixed(1)}%` : `${(p.memMb / 1024).toFixed(1)} GB`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useSystem(minutes: number, announceWatching: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [cur, setCur] = useState<Current | null>(null);
  const [hist, setHist] = useState<Hist | null>(null);
  const load = async () => {
    setCur((await rpc.call("current", null)) as Current);
    setHist((await rpc.call("history", { minutes })) as Hist);
  };
  useEffect(() => {
    void load();
    if (!announceWatching) return;
    // Tell the sampler someone is looking, so it samples at the fast cadence.
    void rpc.call("watching", null);
    const t = setInterval(() => void rpc.call("watching", null), 60_000);
    return () => clearInterval(t);
  }, []);
  useRealtime("system.sample", () => {
    void load();
  });
  return { cur, hist };
}

function SystemPanel() {
  const { cur, hist } = useSystem(60, true);
  const s = cur?.sample;
  if (!s) return <div className="p-5 text-muted-foreground text-sm">Sampling… first data arrives shortly.</div>;
  const samples = hist?.samples ?? [];
  const pressure = PRESSURE[s.pressureLevel] ?? String(s.pressureLevel);
  return (
    <div className="p-4 md:p-5 overflow-y-auto h-full">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Tile label="CPU" value={`${Math.round(s.cpuPct)}%`} sub={`${s.cpuCount} cores · load ${s.load1.toFixed(2)}`} frac={s.cpuPct / 100} />
          <Tile
            label="Memory used"
            value={`${(s.memUsedMb / 1024).toFixed(1)} GB`}
            sub={`of ${(s.memTotalMb / 1024).toFixed(0)} GB · pressure ${pressure}${s.swapUsedMb > 0 ? ` · swap ${(s.swapUsedMb / 1024).toFixed(1)} GB` : ""}`}
            frac={s.memUsedFrac}
            hot={s.pressureLevel >= 2}
          />
          <Tile label="Disk" value={`${s.diskUsedGb} GB`} sub={`of ${s.diskTotalGb} GB (data volume)`} frac={s.diskUsedGb / (s.diskTotalGb || 1)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Spark title="CPU % — last hour" points={samples.map((x) => x.cpuPct)} max={100} />
          <Spark title="Memory used — last hour" points={samples.map((x) => x.memUsedFrac)} max={1} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ProcTable title="Top CPU" rows={cur!.topCpu} metric="cpu" />
          <ProcTable title="Top memory" rows={cur!.topMem} metric="mem" />
        </div>
        <div className="text-xs text-muted-foreground">{cur!.uptime}</div>
      </div>
    </div>
  );
}

function HomeTiles() {
  const { cur } = useSystem(5, false);
  const s = cur?.sample;
  if (!s) return null;
  return (
    <div className="grid grid-cols-3 gap-3">
      <Tile label="CPU" value={`${Math.round(s.cpuPct)}%`} sub={`${s.cpuCount} cores`} frac={s.cpuPct / 100} />
      <Tile
        label="Memory"
        value={`${Math.round(s.memUsedFrac * 100)}%`}
        sub={`${(s.memUsedMb / 1024).toFixed(1)} GB used`}
        frac={s.memUsedFrac}
        hot={s.pressureLevel >= 2}
      />
      <Tile label="Disk" value={`${Math.round((s.diskUsedGb / (s.diskTotalGb || 1)) * 100)}%`} sub={`${s.diskTotalGb - s.diskUsedGb} GB free`} frac={s.diskUsedGb / (s.diskTotalGb || 1)} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "system", title: "System", icon: "Activity", path: "system", component: SystemPanel });
  app.slots.homepageSection({ id: "system-tiles", title: "System", component: HomeTiles });
});
