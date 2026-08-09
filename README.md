# bb-plugin-system

A live system overview inside [bb](https://getbb.app) — see what the machine is doing
while your agents work it.

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-system.git@main
```

## What it gives you

**System panel** — CPU, memory and disk tiles with status-toned meters, sparklines for
the last hour, and top-process tables by CPU and by memory.

**Homepage tiles** — a compact CPU / memory / disk row.

**`bb system`** — the same data for agents, as text:

```
bb system [overview]   current snapshot with ASCII meters
bb system top          top processes by CPU and memory
bb system history [m]  compact trend for the last N minutes (default 60)
```

Unlike a menu-bar monitor, this keeps **history**: a background sampler writes to a 24-hour
ring buffer, so you can answer "what was this machine doing twenty minutes ago, while that
fleet was running?" — which is the question that actually comes up.

## How it measures

Metrics come from [`systeminformation`](https://www.npmjs.com/package/systeminformation)
(MIT, zero dependencies), which matters more than it sounds:

- **Memory** uses Activity Monitor's basis (`anonymous - purgeable + wired + compressed`).
  Summing `Pages active + wired + compressor` — the obvious `vm_stat` reading — counts
  file-backed cache as used and misses dirty anonymous pages on the inactive queue; on a
  24 GiB machine that understated real usage by over 2 GiB.
- **CPU** is real tick-delta utilization. Dividing load average by core count paints a
  large bar on an idle machine, because load counts blocked threads.
- **Memory pressure** is the kernel signal (`kern.memorystatus_vm_pressure_level`),
  reported separately from used/total. A Mac at 90% used with no swap activity is fine.

**Sampling is adaptive** — every 15s while a thread is running a turn or the panel is
open, every 60s otherwise. A fixed short interval that spawns work each tick fights macOS
timer coalescing to collect data nobody is reading; bb knows when work is happening, so
the plugin uses that.

Top-process tables still shell `ps` directly: systeminformation's darwin implementation
runs the same command with more columns and takes its decayed `pcpu` verbatim.

macOS is the tested platform; the metric library covers Linux and Windows, but the
pressure reading and process table are macOS-specific.

See also [get-bb/bb#1171](https://github.com/get-bb/bb/pull/1171), an open proposal for an
official System Monitor plugin.

## License

MIT
