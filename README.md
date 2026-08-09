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

## Status

macOS only today (it reads `sysctl`, `vm_stat`, `df` and `ps`). Known work in progress:

- Migrating metric collection to [`systeminformation`](https://www.npmjs.com/package/systeminformation)
  for correctness and cross-platform support. The current memory figure is computed from
  the VM active queue, which understates real usage, and the CPU meter is derived from
  load average rather than true utilization.
- Making the sample interval adaptive (frequent while threads are running or the panel is
  open, sparse otherwise) instead of a fixed 15 seconds.

See also [get-bb/bb#1171](https://github.com/get-bb/bb/pull/1171), an open proposal for an
official System Monitor plugin.

## License

MIT
