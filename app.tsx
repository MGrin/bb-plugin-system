// bb-plugin-system frontend — System panel + homepage tiles.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
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
  stale: boolean;
  error: string | null;
};
type Hist = { samples: Sample[] };
type Machine = {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  isPrimary: boolean;
};

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

function useMachines() {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [primaryHostId, setPrimaryHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const hasConnected = useRef(false);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const result = await rpc.call("machines", null);
      if (id !== requestId.current) return;
      setMachines(result.machines as Machine[]);
      setPrimaryHostId(result.primaryHostId);
      setError(null);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : "Unable to load machines");
    }
  }, [rpc]);
  useEffect(() => {
    void load();
    return () => { requestId.current++; };
  }, [load]);
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (hasConnected.current) void load();
    hasConnected.current = true;
  }, [connectionState, load]);
  useEffect(() => {
    if (!error || connectionState !== "connected") return;
    const timer = setTimeout(() => void load(), 5_000);
    return () => clearTimeout(timer);
  }, [connectionState, error, load]);
  useRealtime("system.machines", () => { void load(); });
  return { machines, primaryHostId, error };
}

function MachineSelect(props: {
  machines: Machine[];
  value: string;
  onChange: (hostId: string) => void;
}) {
  return (
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger
        aria-label="Machine"
        className="h-8 border-border/70 bg-muted/20 px-2.5 py-0 text-xs font-medium shadow-none hover:bg-muted/40 focus:ring-1 data-[state=open]:bg-muted/40 [&>svg]:size-3.5 [&>svg]:opacity-60"
        style={{ width: 180 }}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="end"
        sideOffset={4}
        className="[&_[role=option]>span:last-child]:truncate"
        style={{ width: "var(--radix-select-trigger-width)", minWidth: "var(--radix-select-trigger-width)" }}
      >
        {props.machines.map((machine) => (
          <SelectItem
            key={machine.id}
            value={machine.id}
            disabled={machine.status === "disconnected"}
            className="text-xs"
          >
            {machine.name}{machine.isPrimary ? " (primary)" : ""}
            {machine.status === "disconnected" ? " — offline" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function useSystem(hostId: string | null, minutes: number, announceWatching: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [cur, setCur] = useState<Current | null>(null);
  const [hist, setHist] = useState<Hist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadId = useRef(0);
  const load = useCallback(async () => {
    if (!hostId) return;
    const requestId = ++loadId.current;
    try {
      const [nextCur, nextHist] = await Promise.all([
        rpc.call("current", { hostId }),
        rpc.call("history", { hostId, minutes }),
      ]);
      if (requestId !== loadId.current) return;
      setCur(nextCur as Current);
      setHist(nextHist as Hist);
      setError(null);
    } catch (cause) {
      if (requestId !== loadId.current) return;
      setError(cause instanceof Error ? cause.message : "Unable to load system metrics");
    }
  }, [hostId, minutes, rpc]);
  useEffect(() => {
    loadId.current++;
    setCur(null);
    setHist(null);
    setError(null);
    if (!hostId) return;
    void load();
    const timer = announceWatching
      ? setInterval(() => void rpc.call("watching", { hostId }), 60_000)
      : null;
    if (announceWatching) {
      // Tell the sampler someone is looking, so it samples at the fast cadence.
      void rpc.call("watching", { hostId });
    }
    return () => {
      loadId.current++;
      if (timer) clearInterval(timer);
    };
  }, [announceWatching, hostId, load, rpc]);
  useRealtime("system.sample", (event) => {
    // The sampler publishes for every connected host; only the machine on
    // screen needs a reload.
    const payload = event as { hostId?: string } | null;
    if (payload?.hostId && payload.hostId !== hostId) return;
    void load();
  });
  return { cur, hist, error };
}

function SystemPanel() {
  const { machines, primaryHostId, error: machineError } = useMachines();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  useEffect(() => {
    if (!machines.length) return;
    setSelectedHostId((current) =>
      current && machines.some((machine) => machine.id === current)
        ? current
        : primaryHostId ?? machines[0]!.id,
    );
  }, [machines, primaryHostId]);
  const { cur, hist, error } = useSystem(selectedHostId, 60, true);
  const s = cur?.sample;
  const samples = hist?.samples ?? [];
  return (
    <div className="p-4 md:p-5 overflow-y-auto h-full">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex justify-end">
          {selectedHostId && machines.length > 0 ? (
            <MachineSelect machines={machines} value={selectedHostId} onChange={setSelectedHostId} />
          ) : null}
        </div>
        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            Could not load this machine: {error}
          </div>
        ) : null}
        {machineError && machines.length === 0 ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            Could not load machines: {machineError}
          </div>
        ) : null}
        {cur?.stale && s ? (
          <div className="rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm text-foreground">
            Showing the last sample from {new Date(s.ts).toLocaleTimeString()}.
            {cur.error ? ` ${cur.error}.` : " Live sampling is unavailable."}
          </div>
        ) : null}
        {cur?.stale && !s ? (
          <div className="rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm text-foreground">
            {cur.error ?? "This machine is unavailable and has no saved samples yet."}
          </div>
        ) : null}
        {!s && !error && !cur?.stale ? (
          <div className="py-8 text-center text-muted-foreground text-sm">Sampling… first data arrives shortly.</div>
        ) : null}
        {s ? <SystemDetails current={cur!} samples={samples} /> : null}
      </div>
    </div>
  );
}

function SystemDetails({ current, samples }: { current: Current; samples: Sample[] }) {
  const s = current.sample!;
  const pressure = PRESSURE[s.pressureLevel] ?? String(s.pressureLevel);
  return (
    <>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Tile label="CPU" value={`${Math.round(s.cpuPct)}%`} sub={`${s.cpuCount} cores · load ${s.load1.toFixed(2)}`} frac={s.cpuPct / 100} />
          <Tile
            label="Memory used"
            value={`${(s.memUsedMb / 1024).toFixed(1)} GB`}
            sub={`of ${(s.memTotalMb / 1024).toFixed(0)} GB · pressure ${pressure}${s.swapUsedMb > 0 ? ` · swap ${(s.swapUsedMb / 1024).toFixed(1)} GB` : ""}`}
            frac={s.memUsedFrac}
            hot={s.pressureLevel >= 2}
          />
          <Tile label="Disk" value={`${s.diskUsedGb} GB`} sub={`of ${s.diskTotalGb} GB`} frac={s.diskUsedGb / (s.diskTotalGb || 1)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Spark title="CPU % — last hour" points={samples.map((x) => x.cpuPct)} max={100} />
          <Spark title="Memory used — last hour" points={samples.map((x) => x.memUsedFrac)} max={1} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ProcTable title="Top CPU" rows={current.topCpu} metric="cpu" />
          <ProcTable title="Top memory" rows={current.topMem} metric="mem" />
        </div>
        <div className="text-xs text-muted-foreground">{current.uptime}</div>
    </>
  );
}

function HomeTiles() {
  const { primaryHostId } = useMachines();
  const { cur } = useSystem(primaryHostId, 5, false);
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
