# ios

Agent-friendly iOS simulator CLI. Thin wrapper around `simctl` and an idb
companion gRPC endpoint, with JSON in / JSON out for easy scripting.

## Requirements

- macOS with Xcode + `xcrun simctl`
- [Bun](https://bun.sh)
- An `idb_companion` running against your simulator (default: `localhost:10882`)

## Install

```sh
bun install
bun run build    # produces ./dist/ios
```

Or run directly:

```sh
bun run src/index.ts --help
```

## Usage

```
ios [--udid <id|booted>] [--companion <host:port>] <command> [args]
```

Defaults: `--udid booted`, `--companion localhost:10882`. Overridable via
`IDB_UDID` / `IDB_COMPANION` env vars.

### Commands

| Command | Description |
| --- | --- |
| `list-devices` | list all simulators |
| `list-apps` | list installed apps |
| `install <path>` | install `.app` / `.ipa` |
| `uninstall <bundle_id>` | |
| `launch <bundle_id> [args...]` | returns `{pid}` |
| `terminate <bundle_id>` | |
| `logs [--follow] [--last 1m] [--predicate '<NSPredicate>']` | |
| `screenshot [--out file.png] [--base64]` | |
| `describe [--point x,y] [--screenshot]` | AX tree (+ optional base64 png) |
| `tap <x> <y> [--duration s]` | |
| `swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]` | |
| `text "<string>"` | |
| `button <home\|lock\|siri\|side_button\|apple_pay> [--duration s]` | |

All commands write JSON to stdout on success and `{"error": "..."}` to stderr
on failure with a non-zero exit code.

## License

MIT — see [LICENSE](./LICENSE). `src/idb.proto` is derived from
[facebook/idb](https://github.com/facebook/idb) (also MIT).
