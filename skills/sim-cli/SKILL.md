---
name: sim-cli
description: Drive a booted iOS Simulator from the command line — build/install/launch apps, read accessibility trees, tap/swipe/type, capture screenshots and logs. Use when the user asks to interact with a simulator, automate iOS UI, run a built app, debug a UI flow, or grab a screenshot/AX dump from the iPhone Simulator.
---

# sim-cli

Thin agent-friendly wrapper around `xcrun simctl`, `xcodebuild`, and `idb_companion`. Every command writes a single JSON object to stdout on success and `{"error": "..."}` to stderr (exit 1) on failure.

## Prerequisites

Before issuing any command, verify the environment:

1. A simulator is booted: `xcrun simctl list devices booted -j`. If none, ask the user which device to boot or run `xcrun simctl boot <udid>`.
2. `idb_companion` is running for that UDID: `pgrep -fl idb_companion`. If missing for the target sim, start one:
   ```
   idb_companion --udid <UDID> --grpc-domain-sock /tmp/idb/<UDID>_companion.sock --only simulator &
   ```
   The CLI auto-discovers `/tmp/idb/<UDID>_companion.sock` when present, so you usually don't need `--companion`.
3. If multiple sims are booted, never rely on `--udid booted` — pass the explicit UDID (or `export IDB_UDID=<udid>`).
4. Optional but recommended: `xcpretty` on PATH (`gem install xcpretty`). `run` pipes `xcodebuild` through it for cleaner build output; falls back to raw output otherwise.

## Invocation

From the repo root: `bun run src/index.ts <cmd>` during development, or `./dist/sim-cli <cmd>` after `bun run build`. Globals can be in any position:

- `--udid <id|booted>` (or `IDB_UDID`)
- `--companion <host:port|/path/to.sock>` (or `IDB_COMPANION`)

## Command map

| Goal | Command |
| --- | --- |
| Inventory devices | `list-devices` |
| What's installed | `list-apps` |
| Remove app | `uninstall <bundle_id>` |
| Build, install, launch | `run <bundle_id> [args...]` (see flags below) |
| Skip build, use existing artifact | `run <bundle_id> --no-build` or `run <bundle_id> --app <path>` |
| Just relaunch installed app | `run <bundle_id> --no-build --no-install` |
| Open a deep link / URL | `openurl <url>` |
| Recent logs | `logs --last 1m` → JSON array of entries; filter client-side with `jq` |
| Stream logs | `logs --follow` → ndjson per line; blocks (use sparingly) |
| Pixel screenshot | `screenshot [--out file.png] [--base64]` |
| AX tree | `describe [--point x,y] [--screenshot]` |
| Tap (coords or label) | `tap <x> <y>` or `tap --label "Settings"` |
| Swipe | `swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]` |
| Type | `type "hello"` |
| Hardware button | `press <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` |

### `run` flags

`run` is the single app-lifecycle command. Default order: **build → install → terminate prior → launch → wait-for-frontmost.** Each step has a skip flag.

| Flag | Effect |
| --- | --- |
| `--workspace <path>` | Xcode workspace (auto-detected in CWD if omitted) |
| `--project <path>` | Xcode project (auto-detected in CWD if omitted) |
| `--scheme-name <name>` | scheme to build (auto-detected if only one) |
| `--configuration Debug\|Release` | build configuration (default `Debug`) |
| `--app <path>` | use prebuilt `.app`; implies `--no-build` |
| `--no-build` | skip `xcodebuild`; use newest artifact in DerivedData |
| `--no-install` | use the already-installed app |
| `--no-terminate` | don't kill any prior instance |
| `--no-wait` | don't wait for frontmost (`ready` omitted from output) |
| `--env KEY=VAL` | pass env to launched app (repeatable) |
| `--scheme <path>` | read enabled `LaunchAction` env from `.xcscheme` or `.xcodeproj` |

Build errors are surfaced: on `xcodebuild` failure, the last 80 lines of output land in the `{"error": "..."}` payload.

## Idiomatic flows

**Smoke-test a freshly built app**
```
sim-cli run com.acme.MyApp                       # auto-detects workspace + scheme, builds, installs, launches
sim-cli screenshot --out /tmp/after-launch.png
sim-cli describe
sim-cli logs --last 30s | jq '.[] | select(.processImagePath | contains("MyApp"))'
```

**Skip the build for a fast inner loop** — when source hasn't changed:
```
sim-cli run com.acme.MyApp --no-build            # uses newest .app in DerivedData
```

**Drive a UI flow without hardcoding coordinates** — prefer `tap --label` over raw coordinates; the AX tree is the source of truth. Use `describe` + `jq` to inspect when needed.
```
sim-cli describe | jq '.. | objects | select(.AXLabel? == "Sign In")'
sim-cli tap --label "Sign In"
sim-cli type "user@example.com"
```

**Jump straight into a deep link** instead of tapping through:
```
sim-cli openurl "myapp://orders/123"
```

**Capture state for analysis** — `describe --screenshot` returns both the AX tree and a base64 PNG in one shot, ideal for a single round-trip when investigating a screen.

## Gotchas

- `tap`, `swipe`, `type`, `press`, `describe` go through `idb_companion`. If they hang or return `UNAVAILABLE`, the companion for that UDID isn't running — start it (see prerequisites).
- `--udid booted` errors out when more than one sim is booted. Prefer an explicit UDID in multi-sim setups.
- `run` waits for the app to register with launchd before returning (`ready: true/false`) unless `--no-wait` is set. If `ready` is false, the launch raced — re-launch.
- `run` without `--no-build` invokes `xcodebuild` every time. Pass `--no-build` for fast iteration when only re-launching.
- AX-tree frames are in points, already in the same space `tap` expects — don't multiply by scale.
- `type` uses HID key events, so it types into whatever has keyboard focus. Tap the field first.
- `tap --label/--role/--text` does substring matching against the AX tree (case-insensitive). If multiple elements match, the first is tapped — disambiguate by combining flags or using `describe` + `jq`.
- `logs --follow` blocks until SIGINT — only use when the user explicitly asks to stream; otherwise use `--last`.
- `logs` has no app-level server-side filter — Apple subsystem chatter is dropped by default (`-v` lifts that), but narrowing to a specific app or message is done client-side with `jq`. Each entry has `timestamp`, `subsystem`, `category`, `processImagePath`, `eventMessage`, `messageType`, etc.
  ```
  sim-cli logs --last 5m | jq '.[] | select(.processImagePath | contains("MyApp")) | select(.messageType == "Error")'
  ```

## Parsing output

Every success payload is a single line of JSON. Pipe to `jq` or parse directly. Errors land on stderr as `{"error": "..."}` with exit code 1 — always check exit status before trusting stdout.

`logs` (one-shot) returns a JSON array — each element is a parsed `log show --style ndjson` entry. `logs --follow` streams the same ndjson, one object per line, until SIGINT.
