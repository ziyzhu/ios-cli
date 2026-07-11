# sim-cli

Agent-friendly iOS simulator CLI. Thin wrapper around `simctl` and an idb
companion gRPC endpoint, with JSON in / JSON out for easy scripting.

## Requirements

- macOS with Xcode + `xcrun simctl`
- [Bun](https://bun.sh)
- An `idb_companion` running against your simulator (default: `localhost:10882`)
- Optional: [`xcpretty`](https://github.com/xcpretty/xcpretty) — `run` pipes
  `xcodebuild` output through it when available

## Install

```sh
bun install
bun run build    # produces ./dist/sim
```

Or run directly:

```sh
bun run src/index.ts --help
```

## Usage

```
sim [--device <name|udid|booted>] [--companion <host:port>] <command> [args]
```

Defaults: `--device booted`, `--companion localhost:10882`. Overridable via
`SIM_DEVICE` / `IDB_COMPANION` env vars (`--udid` / `IDB_UDID` still accepted).
`--device` takes a simulator name (e.g. `mango-qa`, set via `devices rename`),
a UDID, or `booted`; names resolve case-insensitively, preferring a booted
match when several runtimes share the name.

Help is progressively disclosed: `sim --help` prints a grouped command
overview; `sim help <command>` (or `sim <command> --help`) discloses the
flags and details for one command; `sim agent-context` returns the full
command schema as versioned machine-readable JSON (`schema_version`, per-command
args/flags with enum values and aliases) — the layer an agent should consume to
learn the surface without parsing help text.

### Commands

**Device**

| Command | Description |
| --- | --- |
| `devices` | list all simulators (alias: `list-devices`) |
| `devices rename <device> <new_name>` | rename a simulator; the name then works anywhere `--device` is accepted |
| `devices clone <source> <new_name>` | clone a simulator by name or UDID |
| `devices boot <device>` | boot a simulator and wait until it is ready |
| `devices shutdown <device>...` | shut down one or more explicit simulators by name or UDID; already-shutdown devices are unchanged |
| `list-apps` | list installed apps |
| `uninstall <bundle_id>` | remove app |
| `keyboard status\|connect\|disconnect` | toggle the target device's live hardware keyboard via the Simulator I/O menu (`enable`/`disable` aliases); `disconnect` shows the software keyboard like a real device. Needs an open Simulator window + Accessibility permission; state persists (no auto-connect) |
| `file <list\|pull\|push\|delete\|mkdir\|mv> <bundle_id> ...` | read/write the app container (`list`/`delete` accept `ls`/`rm` aliases); `--container app\|data` (default `data`), `--dest <dir>` for `file pull` |

**App**

| Command | Description |
| --- | --- |
| `run <bundle_id> [args...]` | build → install → terminate prior → launch → wait → capture logs. Auto-detects `.xcworkspace` / `.xcodeproj` + scheme; override with `--workspace`, `--project`, `--scheme`, `--configuration`, or pass `--app <path>` to launch a prebuilt artifact instead of building. Enabled `LaunchAction` env vars + command-line args from the matching `.xcscheme` are picked up automatically; pass extra/override env via `--env KEY=VAL` (repeatable). Detaches a verbose ndjson `log stream` to `~/.sim-cli/logs/<udid>.log` (truncated each run, all subsystems) and reports `{logs:{file,pid}}`. The next `run` replaces that streamer; inspect or find it with `logs` / `config`. |
| `openurl <url>` | open a URL / deep link |

**State** — everything sim-cli persists lives under `~/.sim-cli/`.

| Command | Description |
| --- | --- |
| `config` | dump `~/.sim-cli/`: the `dir` path, the companion registry (per-UDID idb companions, each with `alive`), and `captures` (the log files `run` produced). |
| `logs [--device <name\|udid>]` | list captured log files from prior runs — `udid`, `file`, `size`, `modified`, `capturing`, and live `pid`. Read a file directly with `tail`/`jq`. `--device` scopes to one sim. |
| `defaults read\|write\|delete <domain> ...` | manage simulator defaults; `write` accepts `--type string\|bool\|int\|float` |
| `pasteboard get\|set [value]` | read or replace the simulator pasteboard |

**Observe**

| Command | Description |
| --- | --- |
| `screenshot [--out file.png] [--base64]` | capture screen as PNG |
| `describe [--point x,y] [--screenshot]` | accessibility tree (+ optional base64 PNG) |

**Diagnostics** — the app's simulator process is a plain host process, so these
read it directly (no Xcode). All take the app by bundle id and resolve the pid
through the target device's launchd, never by process name.

| Command | Description |
| --- | --- |
| `stats <bundle_id> [--watch]` | resource gauges via `proc_pid_rusage`: CPU %, memory footprint (current + lifetime peak), disk I/O. One-shot adds net bytes for open sockets and the data container's size on disk; `--watch` emits one NDJSON line per second until the process exits. App process only — WKWebView helper processes are separate pids and excluded. |
| `hierarchy <bundle_id> [--vc] [--out file.txt]` | UIKit view hierarchy (`recursiveDescription`), or the view-controller tree with `--vc`, via a batch lldb attach. Suspends the app for a few seconds and needs a debuggable (Debug) build; fails cleanly if another debugger is attached. Writes the tree to a file and returns its path. |
| `memory [footprint] <bundle_id>` | categorized dirty-memory breakdown (`footprint` tool) |
| `memory leaks <bundle_id> [--out file.txt]` | leaks scan — count + bytes inline, full report to file; briefly suspends the app |
| `memory warn` | simulated memory warning, delivered device-wide |
| `sample <bundle_id> [--duration s] [--out file.txt]` | CPU profile: 1ms call-stack sampling, no attach pause. Top-of-stack summary inline, full call tree to file. |

**Interact**

| Command | Description |
| --- | --- |
| `wait --label\|--role\|--text\|--id <s> [--timeout ms] [--stable ms] [--missing]` | wait for a visible match, stable frame, or disappearance |
| `tap <x> <y> [--duration s]` | tap at coordinates; or use a selector with `--wait`, `--stable`, and `--settle` to wait for a stable, hit-testable match |
| `swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]` | swipe between points, or use `--direction up\|down\|left\|right` with optional `--edge`, `--distance`, and an AX selector |
| `type "<string>"` | send keystrokes to focused field |
| `fill --label\|--role\|--text\|--id <s> "<value>" [--replace] [--wait ms] [--settle ms]` | tap a field, wait for focus, then append or replace its value |
| `press <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` | press a hardware button |

All commands write JSON to stdout on success and `{"error": "..."}` to stderr
on failure with a non-zero exit code.

## License

MIT — see [LICENSE](./LICENSE). `src/idb.proto` is derived from
[facebook/idb](https://github.com/facebook/idb) (also MIT).
