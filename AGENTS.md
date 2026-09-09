<!-- agents-md ceiling: 60 lines -->
# AGENTS.md — bb-plugin-system

A bb plugin showing what the machine is doing while agents work it: a System panel,
homepage tiles and a `bb system` CLI, with 24h of per-machine history.
[`README.md`](README.md) is the user-facing document, and its **"How it measures"** section
is the part to read before touching a metric — every reading in this plugin was chosen
against a wrong one that looked right.

## Commands, all run 2026-09-09

```sh
npm install          # rc=0
npm test             # node --test over lib/*.test.ts — 12 tests, 0 fail
npm run typecheck    # tsc --noEmit, rc=0
bb plugin build .    # dist/{server,app}.js + .meta.json + app.css
```

## The gate

Those two scripts plus three GitHub Actions workflows: `test.yml`, `typecheck.yml` and
`managed-install.yml`. The last is the one a green local run cannot stand in for — bb's
managed git install resolves **runtime dependencies only**
(`npm install --omit=dev --omit=optional --ignore-scripts`) and then builds, so a module
imported at runtime but parked in `devDependencies` works here and fails for every real
user. `systeminformation`, the Radix/Hugeicons UI packages and `zod` are runtime and sit
in `dependencies` for exactly that reason; `better-sqlite3` and `hono` are types-only and
must not move.

## Layout

| path | what it is |
|---|---|
| `server.ts` | sampler, ring buffer, `bb system` commands, remote-machine sampling |
| `lib/` | the pieces with their own tests (`battery.ts`), plus UI helpers |
| `app.tsx`, `components/`, `hooks/` | the panel and the homepage tiles |
| `components.json` | shadcn config — `components/ui/**` is generated, do not hand-edit |

## Conventions that differ from the defaults

- **Tests are `node --test --experimental-strip-types` over `lib/*.test.ts`.** A new suite
  outside `lib/` is invisible to `npm test`; put it there or widen the glob deliberately.
- **A metric must name its basis.** Memory is Activity Monitor's
  (`anonymous - purgeable + wired + compressed`), CPU is real tick-delta utilization, and
  pressure is the kernel signal reported separately. The obvious alternatives were measured
  and are wrong — see the README before replacing one.
- **Sampling is adaptive on purpose** — 15s while a thread is running a turn or the panel
  is open, 60s otherwise, driven by what bb knows about live work. A fixed short interval
  is not a simplification; it collects data nobody is reading and fights timer coalescing.
- **Top processes shell `ps` directly**, deliberately, rather than going through
  `systeminformation` — which runs the same command and takes its decayed `pcpu` verbatim.
- **A remote machine is sampled through its own bb daemon**, never by reading this
  process's filesystem. macOS is the tested platform; Linux is supported remotely; Windows
  machines list but cannot be sampled.

**Nothing about who may merge, how agents are spawned, or how the maintainer's
machine handles secrets belongs in this file, and none of it is stated here.**
Those are properties of a working environment, not of this project; if you are
contributing, your own conventions apply and nothing in this repo depends on
the maintainer's.
