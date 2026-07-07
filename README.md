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
bun run build    # produces ./dist/sim-cli
```

Or run directly:

```sh
bun run src/index.ts --help
```

## Usage

```
sim-cli [--device <name|udid|booted>] [--companion <host:port>] <command> [args]
```

Defaults: `--device booted`, `--companion localhost:10882`. Overridable via
`SIM_DEVICE` / `IDB_COMPANION` env vars (`--udid` / `IDB_UDID` still accepted).
`--device` takes a simulator name (e.g. `mango-qa`, set via `devices rename`),
a UDID, or `booted`; names resolve case-insensitively, preferring a booted
match when several runtimes share the name.

Help is progressively disclosed: `sim-cli --help` prints a grouped command
overview; `sim-cli help <command>` (or `sim-cli <command> --help`) discloses the
flags and details for one command; `sim-cli agent-context` returns the full
command schema as versioned machine-readable JSON (`schema_version`, per-command
args/flags with enum values and aliases) — the layer an agent should consume to
learn the surface without parsing help text.

### Commands

**Device**

| Command | Description |
| --- | --- |
| `devices` | list all simulators (alias: `list-devices`) |
| `devices rename <device> <new_name>` | rename a simulator; the name then works anywhere `--device` is accepted |
| `list-apps` | list installed apps |
| `uninstall <bundle_id>` | remove app |
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

**Observe**

| Command | Description |
| --- | --- |
| `screenshot [--out file.png] [--base64]` | capture screen as PNG |
| `describe [--point x,y] [--screenshot]` | accessibility tree (+ optional base64 PNG) |

**Interact**

| Command | Description |
| --- | --- |
| `tap <x> <y> [--duration s]` | tap at coordinates; or `tap --label\|--role\|--text\|--id <s> [--wait ms]` to tap matched element's centroid |
| `swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]` | swipe between points |
| `type "<string>"` | send keystrokes to focused field |
| `fill --label\|--role\|--text\|--id <s> "<value>" [--wait ms] [--settle ms]` | tap a field, wait for focus, then type |
| `press <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` | press a hardware button |

All commands write JSON to stdout on success and `{"error": "..."}` to stderr
on failure with a non-zero exit code.

## License

MIT — see [LICENSE](./LICENSE). `src/idb.proto` is derived from
[facebook/idb](https://github.com/facebook/idb) (also MIT).
