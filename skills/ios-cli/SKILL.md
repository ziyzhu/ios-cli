---
name: ios-cli
description: Drive a booted iOS Simulator from the command line — install/launch apps, read accessibility trees, tap/swipe/type, capture screenshots and logs. Use when the user asks to interact with a simulator, automate iOS UI, run a built app, debug a UI flow, or grab a screenshot/AX dump from the iPhone Simulator.
---

# ios-cli

Thin agent-friendly wrapper around `xcrun simctl` and `idb_companion`. Every command writes a single JSON object to stdout on success and `{"error": "..."}` to stderr (exit 1) on failure.

## Prerequisites

Before issuing any command, verify the environment:

1. A simulator is booted: `xcrun simctl list devices booted -j`. If none, ask the user which device to boot or run `xcrun simctl boot <udid>`.
2. `idb_companion` is running for that UDID: `pgrep -fl idb_companion`. If missing for the target sim, start one:
   ```
   idb_companion --udid <UDID> --grpc-domain-sock /tmp/idb/<UDID>_companion.sock --only simulator &
   ```
   The CLI auto-discovers `/tmp/idb/<UDID>_companion.sock` when present, so you usually don't need `--companion`.
3. If multiple sims are booted, never rely on `--udid booted` — pass the explicit UDID (or `export IDB_UDID=<udid>`).

## Invocation

From the repo root: `bun run src/index.ts <cmd>` during development, or `./dist/ios <cmd>` after `bun run build`. Globals can be in any position:

- `--udid <id|booted>` (or `IDB_UDID`)
- `--companion <host:port|/path/to.sock>` (or `IDB_COMPANION`)

## Command map

| Goal | Command |
| --- | --- |
| Inventory devices | `list-devices` |
| What's installed | `list-apps` |
| Install build | `install <path/to/App.app>` |
| Install + launch latest local build | `run <bundle_id> [--app <path>] [--env K=V]...` |
| Launch only | `launch <bundle_id> [args...] [--env K=V] [--terminate-running] [--wait-for-frontmost]` |
| Kill app | `terminate <bundle_id>` |
| Remove app | `uninstall <bundle_id>` |
| Recent logs | `logs --last 1m [--predicate '<NSPredicate>']` |
| Stream logs | `logs --follow [--predicate ...]` (blocks; use sparingly) |
| Pixel screenshot | `screenshot [--out file.png] [--base64]` |
| AX tree | `describe [--point x,y] [--screenshot]` |
| Locate element | `find [--label s] [--role s] [--text s] [--all]` |
| Tap (coords or label) | `tap <x> <y>` or `tap --label "Settings"` |
| Swipe | `swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]` |
| Type | `text "hello"` |
| Hardware button | `button <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` |

## Idiomatic flows

**Smoke-test a freshly built app**
```
ios run com.acme.MyApp                  # build artifact picked from DerivedData
ios screenshot --out /tmp/after-launch.png
ios describe                             # confirm expected screen
ios logs --last 30s --predicate 'subsystem == "com.acme.MyApp"'
```

**Drive a UI flow without hardcoding coordinates** — prefer `find`/`tap --label` over raw coordinates; the AX tree is the source of truth.
```
ios find --label "Sign In"              # inspect frame first
ios tap --label "Sign In"               # then act
ios text "user@example.com"
```

**Capture state for analysis** — `describe --screenshot` returns both the AX tree and a base64 PNG in one shot, ideal for a single round-trip when investigating a screen.

## Gotchas

- `tap`, `swipe`, `text`, `button`, `describe`, `find` go through `idb_companion`. If they hang or return `UNAVAILABLE`, the companion for that UDID isn't running — start it (see prerequisites).
- `--udid booted` errors out when more than one sim is booted. Prefer an explicit UDID in multi-sim setups.
- `run` always waits for the app to register with launchd before returning (`ready: true/false`). If `ready` is false, the launch raced — re-tap or re-launch.
- `find` returns AX-tree coordinates in points, already in the same space `tap` expects — don't multiply by scale.
- `text` uses HID key events, so it types into whatever has keyboard focus. Tap the field first.
- `logs --follow` blocks until SIGINT — only use when the user explicitly asks to stream; otherwise use `--last`.
- Predicates use Apple's NSPredicate syntax (`subsystem == "..."`, `processImagePath CONTAINS "..."`, `eventMessage CONTAINS[c] "..."`).

## Parsing output

Every success payload is a single line of JSON. Pipe to `jq` or parse directly. Errors land on stderr as `{"error": "..."}` with exit code 1 — always check exit status before trusting stdout.
