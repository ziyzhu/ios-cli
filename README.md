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
sim-cli [--udid <id|booted>] [--companion <host:port>] <command> [args]
```

Defaults: `--udid booted`, `--companion localhost:10882`. Overridable via
`IDB_UDID` / `IDB_COMPANION` env vars.

Run `sim-cli --help` for the full grouped reference.

### Commands

**Device**

| Command | Description |
| --- | --- |
| `list-devices` | list all simulators |
| `list-apps` | list installed apps |
| `uninstall <bundle_id>` | remove app |

**App lifecycle**

| Command | Description |
| --- | --- |
| `run <bundle_id> [args...]` | build → install → terminate prior → launch → wait. Skip steps with `--no-build`, `--no-install`, `--no-terminate`, `--no-wait`. Use `--app <path>` for a prebuilt artifact. Auto-detects `.xcworkspace` / `.xcodeproj` + scheme; override with `--workspace`, `--project`, `--scheme-name`, `--configuration`. Pass app env via `--env KEY=VAL` (repeatable) or `--scheme <path>` to read enabled `LaunchAction` env from an `.xcscheme` / `.xcodeproj`. |
| `openurl <url>` | open a URL / deep link |

**Observe**

| Command | Description |
| --- | --- |
| `screenshot [--out file.png] [--base64]` | capture screen as PNG |
| `describe [--point x,y] [--screenshot]` | accessibility tree (+ optional base64 PNG) |
| `logs [--follow] [--last 1m] [--bundle <id>] [--predicate '<NSPredicate>']` | one-shot returns `{lines}`; `--follow` streams raw text. `--bundle` filters to one app's logs (subsystem or process); composable with `--predicate`. |

**Interact**

| Command | Description |
| --- | --- |
| `tap <x> <y> [--duration s]` | tap at coordinates; or `tap --label\|--role\|--text <s>` to tap matched element's centroid |
| `swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]` | swipe between points |
| `type "<string>"` | send keystrokes to focused field |
| `press <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` | press a hardware button |

All commands write JSON to stdout on success and `{"error": "..."}` to stderr
on failure with a non-zero exit code.

## License

MIT — see [LICENSE](./LICENSE). `src/idb.proto` is derived from
[facebook/idb](https://github.com/facebook/idb) (also MIT).
