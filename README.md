# sim-cli

Agent-friendly iOS target CLI. It drives simulators through `simctl`, physical
devices through `devicectl`, and UI automation through an idb companion gRPC
endpoint, with JSON in / JSON out for easy scripting.

## Requirements

- macOS with Xcode + `xcrun simctl` + `xcrun devicectl`
- [Bun](https://bun.sh)
- An `idb_companion` for UI automation; the CLI starts one per target when needed
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

The default target is `--device booted`; companion endpoints are auto-resolved
and started per target. Override through `SIM_DEVICE` / `IDB_COMPANION`
(`--udid` / `IDB_UDID` remain accepted).
`--device` takes a simulator or paired physical iOS device name, a UDID, or
`booted`; names resolve case-insensitively. The default `booted` selects a
simulator. Ambiguous names require a UDID.

### Physical devices

Pair and trust the phone with Xcode, enable Developer Mode, and configure the
app target's signing team. `sim devices` reports paired phones under
`physicalDevices`, including availability, connection, Developer Mode, model,
and OS version.

| Capability | Physical device support |
| --- | --- |
| Discover, list apps, uninstall | `devicectl` |
| Build, install, launch, pass args/env | signed `iphoneos` build + `devicectl` |
| Screenshot, accessibility, tap/swipe/type | idb when its companion can resolve the phone |
| Simulator state and host-process diagnostics | unavailable with an explicit capability error |

Current Apple CLI tooling does not expose general screen input or accessibility
automation through `devicectl`. Physical UI commands therefore require a
compatible idb companion; lifecycle commands remain available when idb cannot
resolve a CoreDevice target.

For a physical `run`, launch-environment URLs must be reachable from the phone.
Scheme or `--env` values using `localhost`, `127/8`, `::1`, or `0.0.0.0` fail
before the app is built or installed because those addresses refer to the phone,
not the Mac. Override scheme values with the Mac's LAN address:

```sh
sim run com.acme.MyApp --device "My iPhone" \
  --env API_ENDPOINT=http://192.168.1.20:8000
```

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
| `devices` | list all simulators and paired physical iOS devices (alias: `list-devices`) |
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
| `build` | build for `generic/platform=iOS Simulator` by default; use `--platform device` for a generic signed build or `--device <physical>` for a device-specific destination. The build cache separates every platform/destination. |
| `run <bundle_id> [args...]` | build → install → terminate prior → launch → wait. Uses `simctl` for simulators and `devicectl` for physical devices. Auto-detects the Xcode container and scheme; accepts `--app`, `--env`, and launch args. Simulator runs additionally capture verbose logs under `~/.sim-cli/logs`. |
| `openurl <url>` | open a URL / deep link |

**State** — everything sim-cli persists lives under `~/.sim-cli/`.

| Command | Description |
| --- | --- |
| `config` | dump `~/.sim-cli/`: the `dir` path, the companion registry (per-UDID idb companions, each with `alive`), `captures` (the log files `run` produced), `builds` (the build cache behind the unchanged-tree skip), and `invocations` (the invocation log). |
| `logs [--device <name\|udid>]` | list Simulator log files from prior runs — `udid`, `file`, `size`, `modified`, `capturing`, and live `pid`. Physical-device log capture is not yet available. |
| `defaults read\|write\|delete <domain> ...` | manage simulator defaults; `write` accepts `--type string\|bool\|int\|float` |
| `pasteboard get\|set [value]` | read or replace the simulator pasteboard |

Every invocation appends one JSON line to `~/.sim-cli/logs/invocations.jsonl`: `ts`, `ms`, `cmd`, `argv` (with `--env` values redacted), `cwd`, `pid`, `exit`, and then either `output` — the *shape* of the result (field names and value types, arrays sampled from their first element, data-keyed dictionaries collapsed to `*`), never its content — or `error` on failure. The file is never rotated; delete it whenever.

```
jq -c 'select(.exit != 0) | {ts, cmd, error}' ~/.sim-cli/logs/invocations.jsonl
```

**Observe**

| Command | Description |
| --- | --- |
| `screenshot [--out file.png] [--base64]` | capture screen as PNG |
| `describe [--point x,y] [--screenshot]` | accessibility tree (+ optional base64 PNG) |

**Diagnostics** — the app's simulator process is a plain host process, so these
read it directly (no Xcode). All take the app by bundle id and resolve the pid
through the target device's launchd, never by process name.

These commands are Simulator-only and return an explicit capability error for
physical targets.

| Command | Description |
| --- | --- |
| `stats <bundle_id> [--watch]` | resource gauges via `proc_pid_rusage`: CPU %, memory footprint (current + lifetime peak), disk I/O. One-shot adds net bytes for open sockets and the data container's size on disk; `--watch` emits one NDJSON line per second until the process exits. App process only — WKWebView helper processes are separate pids and excluded. |
| `hierarchy <bundle_id> [--vc] [--out file.txt]` | UIKit view hierarchy (`recursiveDescription`), or the view-controller tree with `--vc`, via a batch lldb attach. Suspends the app for a few seconds and needs a debuggable (Debug) build; fails cleanly if another debugger is attached. Writes the tree to a file and returns its path. |
| `memory [footprint] <bundle_id>` | categorized dirty-memory breakdown (`footprint` tool) |
| `memory leaks <bundle_id> [--out file.txt]` | leaks scan — count + bytes inline, full report to file; briefly suspends the app |
| `memory warn` | simulated memory warning, delivered device-wide |
| `sample <bundle_id> [--duration s] [--out file.txt]` | CPU profile: 1ms call-stack sampling, no attach pause. Top-of-stack summary inline, full call tree to file. |
| `trace start <bundle_id> [--template time-profiler] [--out file.trace]` | attach native Instruments and wait until recording has begun |
| `trace stop` | stop Instruments and wait for the `.trace` package to finalize |
| `trace export <file.trace> [--xpath expression] [--out file.xml]` | export the trace table of contents or an XPath query without invoking `xctrace` directly |

`trace` is Simulator-only and resolves the app process from its bundle ID. Its
verified Time Profiler capture includes native potential-hang detection, 1ms
call-stack sampling, run-loop events, and Points of Interest. Apple's Animation
Hitches and SwiftUI instruments are not supported on Simulator in Xcode 26; use
a physical device for those. Only one trace can run per simulator, and an
existing output package is never overwritten.
Use `trace export` without `--xpath` first to discover the schemas present in a
recording, then export the relevant table with the XPath shown in that table of
contents.

**Interact**

Simulator interaction works through idb. Physical interaction uses the same
surface when the installed idb companion can resolve the phone; otherwise the
command reports the UI-bridge limitation without affecting lifecycle support.

| Command | Description |
| --- | --- |
| `wait --label\|--role\|--text\|--id <s> [--timeout ms] [--stable ms] [--missing]` | wait for a visible match, stable frame, or disappearance |
| `tap <x> <y> [--duration s]` | tap at coordinates; or use a selector with `--wait`, `--stable`, and `--settle` to wait for a stable, hit-testable match |
| `swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]` | swipe between points, or use `--direction up\|down\|left\|right` with optional `--edge`, `--distance`, and an AX selector |
| `drag <x1> <y1> <x2> <y2> [x y ...]` | one continuous touch: press (`--press s` to lift for drag & drop), move through every waypoint (`--duration s` per segment), optionally pause (`--hold s`), release at the last pair; start from an AX selector instead of the first pair |
| `type "<string>"` | send keystrokes to focused field |
| `fill --label\|--role\|--text\|--id <s> "<value>" [--replace] [--wait ms] [--settle ms]` | tap a field, wait for focus, then append or replace its value |
| `press <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` | press a hardware button |

All commands write JSON to stdout on success and `{"error": "..."}` to stderr
on failure with a non-zero exit code.

## License

MIT — see [LICENSE](./LICENSE). `src/idb.proto` is derived from
[facebook/idb](https://github.com/facebook/idb) (also MIT).
