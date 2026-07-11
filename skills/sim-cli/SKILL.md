---
name: sim-cli
description: Drive a booted iOS Simulator with the `sim` executable — build/install/launch apps, read accessibility trees, tap/swipe/type, capture screenshots and logs. Use when the user asks to interact with a simulator, automate iOS UI, run a built app, debug a UI flow, or grab a screenshot/AX dump from the iPhone Simulator.
---

# sim-cli

Thin agent-friendly wrapper around `xcrun simctl`, `xcodebuild`, and `idb_companion`. Every command writes a single JSON object to stdout on success and `{"error": "..."}` to stderr (exit 1) on failure.

## Prerequisites

Before issuing any command, verify the environment:

1. A simulator is booted: `sim devices`. If none, ask the user which device to boot or run `sim devices boot <device>`.
2. `idb_companion` is running for that UDID: `pgrep -fl idb_companion`. If missing for the target sim, start one:
   ```
   idb_companion --udid <UDID> --grpc-domain-sock /tmp/idb/<UDID>_companion.sock --only simulator &
   ```
   The CLI auto-discovers `/tmp/idb/<UDID>_companion.sock` when present, so you usually don't need `--companion`.
3. If multiple sims are booted, never rely on the `booted` default — pass `--device <name|udid>` (or `export SIM_DEVICE=<name|udid>`).
4. Optional but recommended: `xcpretty` on PATH (`gem install xcpretty`). `run` pipes `xcodebuild` through it for cleaner build output; falls back to raw output otherwise.

## Invocation

From the repo root: `bun run src/index.ts <cmd>` during development, or `./dist/sim <cmd>` after `bun run build`. Globals can be in any position:

- `--device <name|udid|booted>` (or `SIM_DEVICE`; legacy `--udid`/`IDB_UDID` also accepted) — names come from `devices rename`, resolve case-insensitively, and prefer a booted match when several runtimes share the name
- `--companion <host:port|/path/to.sock>` (or `IDB_COMPANION`)

Help is progressively disclosed across three layers — reach for the deepest one you need rather than memorizing the table below:

1. `sim --help` — grouped one-line summary of every command.
2. `sim help <command>` (or `sim <command> --help`) — flags, subcommands, and notes for one command.
3. `sim agent-context` — the full command schema as versioned machine-readable JSON (`schema_version`, per-command `args`/`flags` with `enum` values, `aliases`, `subcommands`). Parse this to learn the surface programmatically; it is generated from the same source as the CLI, so it never drifts.

## Command map

| Goal | Command |
| --- | --- |
| Inventory devices | `devices` (alias: `list-devices`) |
| Name a device | `devices rename <device> <new_name>` — the name then works with `--device` |
| Clone a device | `devices clone <source> <new_name>` |
| Boot and wait | `devices boot <device>` |
| Shut down devices | `devices shutdown <device>...` — explicit names or UDIDs only; already-shutdown devices are unchanged |
| What's installed | `list-apps` |
| Remove app | `uninstall <bundle_id>` |
| Control keyboard | `keyboard status\|connect\|disconnect` (`enable`/`disable` aliases); toggles the device's live hardware keyboard via the Simulator I/O menu. `disconnect` shows the software keyboard like a real device (needs an open Simulator window + Accessibility permission); state persists |
| Read/write a container file | `file list\|pull\|push\|delete\|mkdir\|mv <bundle_id> ...` (`ls`/`rm` aliases accepted; `--container app\|data`, `--dest <dir>` for `file pull`) |
| Build, install, launch | `run <bundle_id> [args...]` (see flags below) |
| Launch a prebuilt artifact | `run <bundle_id> --app <path>` |
| Open a deep link / URL | `openurl <url>` |
| Inspect `~/.sim-cli/` state | `config` → dir, companion registry, captured log files |
| Captured log files | `logs [--device <name\|udid>]` → list of `{udid,file,size,modified,capturing,pid}` |
| Read a captured log | `tail -f ~/.sim-cli/logs/<udid>.log \| jq ...` (path comes from `logs`) |
| Pixel screenshot | `screenshot [--out file.png] [--base64]` |
| AX tree | `describe [--point x,y] [--screenshot]` |
| Resource gauges | `stats <bundle_id> [--watch]` — CPU %, footprint, disk I/O; app process only (WebKit helpers excluded) |
| View hierarchy (frames/layers) | `hierarchy <bundle_id> [--vc]` — lldb attach; suspends the app a few seconds, never mid-gesture |
| Memory breakdown / leaks | `memory <bundle_id>` / `memory leaks <bundle_id>` / `memory warn` (device-wide warning) |
| CPU profile (where time goes) | `sample <bundle_id> [--duration s]` — no attach pause |
| Wait for UI | `wait --id <id> [--timeout ms] [--stable ms] [--missing]` |
| Tap (coords or label) | `tap <x> <y>` or `tap --label "Settings" --wait 5000 --stable 200` |
| Swipe | `swipe --direction up\|down\|left\|right [--edge left\|right\|top\|bottom] [--distance 0.55]`, or explicit coordinates |
| Type | `type "hello"` |
| Fill a field | `fill --label "Email" "user@example.com" [--replace]` |
| Read/write defaults | `defaults read\|write\|delete <domain> ...` |
| Read/write pasteboard | `pasteboard get\|set [value]` |
| Hardware button | `press <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` |

### `run` flags

`run` is the single app-lifecycle command and always runs the full order: **build → install → terminate prior → launch → wait-for-frontmost → capture logs.** The only way to skip the build is to hand it a prebuilt `.app` via `--app`.

| Flag | Effect |
| --- | --- |
| `--workspace <path>` | Xcode workspace (auto-detected in CWD if omitted) |
| `--project <path>` | Xcode project (auto-detected in CWD if omitted) |
| `--scheme <name>` | scheme to build; also reads enabled `LaunchAction` env vars + args from the matching `.xcscheme` (auto-detected if only one) |
| `--configuration Debug\|Release` | build configuration (default `Debug`) |
| `--app <path>` | launch a prebuilt `.app` instead of building |
| `--env KEY=VAL` | pass env to launched app, overrides scheme value (repeatable) |

Build errors are surfaced: on `xcodebuild` failure, the output lands in the `{"error": "..."}` payload.

## Idiomatic flows

**Smoke-test a freshly built app**
```
sim run com.acme.MyApp                       # auto-detects workspace + scheme, builds, installs, launches, captures logs
sim screenshot --out /tmp/after-launch.png
sim describe
sim logs                                      # find the capture file run just started
tail -f "$(sim logs | jq -r '.[0].file')" | jq -c 'select(.subsystem=="com.acme.MyApp")'
```

**Skip the build for a fast inner loop** — when you already have an artifact:
```
sim run com.acme.MyApp --app /path/to/MyApp.app
```

**Drive a UI flow without hardcoding coordinates** — prefer `tap --label` over raw coordinates; the AX tree is the source of truth. Use `describe` + `jq` to inspect when needed.
```
sim describe | jq '.. | objects | select(.AXLabel? == "Sign In")'
sim tap --label "Sign In" --wait 5000 --stable 200
sim fill --label "Email" "user@example.com" --replace
```

**Jump straight into a deep link** instead of tapping through:
```
sim openurl "myapp://orders/123"
```

**Capture state for analysis** — `describe --screenshot` returns both the AX tree and a base64 PNG in one shot, ideal for a single round-trip when investigating a screen.

## Gotchas

- `tap`, `swipe`, `type`, `press`, `describe` go through `idb_companion`. If they hang or return `UNAVAILABLE`, the companion for that UDID isn't running — start it (see prerequisites).
- The `booted` default errors out when more than one sim is booted. Prefer an explicit `--device <name|udid>` in multi-sim setups.
- `run` waits for the app to register with launchd before returning (`ready: true/false`). If `ready` is false, the launch raced — re-launch.
- `run` invokes `xcodebuild` every time unless you pass `--app <path>`. Build once, then `--app` for a fast inner loop.
- AX-tree frames are in points, already in the same space `tap` expects — don't multiply by scale.
- `type` uses HID key events, so it types into whatever has keyboard focus. Tap the field first (or use `fill`, which taps then types).
- `tap --label/--role/--text` does substring matching against the AX tree (case-insensitive). If multiple elements match, the first is tapped — disambiguate by combining flags or using `describe` + `jq`.
- `run` detaches a verbose ndjson `log stream` (all subsystems, debug level) to `~/.sim-cli/logs/<udid>.log`, truncated each run, and reports `{logs:{file,pid}}`. The streamer outlives `run` and is replaced by the next `run`. There is no stop command — to end one early, kill the `pid` from `logs`/`config` (`kill -- -<pid>` to take the whole group). The verbose firehose grows fast (tens of MB/min), so don't leave one running between sessions.
  ```
  tail -f "$(sim logs | jq -r '.[0].file')" | jq -c 'select(.subsystem=="com.acme.MyApp")'
  ```
- `logs` and `config` only read `~/.sim-cli/` state — they never touch the simulator, so they're safe to call anytime (no companion needed).

## Parsing output

Every success payload is a single line of JSON. Pipe to `jq` or parse directly. Errors land on stderr as `{"error": "..."}` with exit code 1 — always check exit status before trusting stdout.

`config` returns `{dir, companions, captures}`; `logs` returns the `captures` array alone. Each capture's `file` is a verbose ndjson log stream (one `log show`-style object per line) you read with `tail`/`jq`.
