#!/usr/bin/env bun
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as simctl from "./simctl.ts";
import * as companion from "./companion.ts";

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { cmd: string; sub?: string; pos: string[]; flags: Flags } {
  const [cmd, ...rest] = argv;
  const pos: string[] = [];
  const flags: Flags = {};
  let sub: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[k] = next; i++; }
      else flags[k] = true;
    } else if (sub === undefined && cmd && !cmd.startsWith("-")) {
      // first positional may be a subcommand for grouped commands
      if (pos.length === 0 && /^[a-z][a-z-]*$/.test(a) && cmd === "app") sub = a;
      else pos.push(a);
    } else {
      pos.push(a);
    }
  }
  return { cmd: cmd ?? "", sub, pos, flags };
}

function ok(data: unknown): never {
  if (data !== undefined) process.stdout.write(JSON.stringify(data) + "\n");
  process.exit(0);
}
function fail(msg: string): never {
  process.stderr.write(JSON.stringify({ error: msg }) + "\n");
  process.exit(1);
}

const HELP = `ios — agent-friendly iOS simulator CLI

Globals: --udid <id|booted>  --companion <host:port>  (default: booted, localhost:10882)

Commands:
  list-devices                          list all simulators (json)
  list-apps                             list installed apps (json)
  install <path>                        install .app/.ipa
  uninstall <bundle_id>
  launch <bundle_id> [args...]          returns {pid}
  terminate <bundle_id>
  logs [--follow] [--last 1m] [--predicate '<NSPredicate>']
  screenshot [--out file.png] [--base64]
  describe [--point x,y] [--screenshot] returns AX tree (+optional base64 png)
  tap <x> <y> [--duration s]
  swipe <x1> <y1> <x2> <y2> [--duration s] [--delta n]
  text "<string>"
  button <home|lock|siri|side_button|apple_pay> [--duration s]
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const { cmd, pos, flags } = parse(argv);
  const udid = (flags.udid as string) || process.env.IDB_UDID || "booted";
  const target = (flags.companion as string) || process.env.IDB_COMPANION || discoverCompanion(udid) || "localhost:10882";

  const withClient = async <T>(fn: (c: any) => Promise<T>): Promise<T> => {
    const c = companion.makeClient(target);
    try { return await fn(c); }
    finally { c.close?.(); }
  };

  switch (cmd) {
    case "list-devices": ok(simctl.listDevices());
    case "list-apps": ok(simctl.listApps(udid));
    case "install": {
      if (!pos[0]) fail("install requires <path>");
      simctl.install(udid, pos[0]); ok({ ok: true });
    }
    case "uninstall": {
      if (!pos[0]) fail("uninstall requires <bundle_id>");
      simctl.uninstall(udid, pos[0]); ok({ ok: true });
    }
    case "launch": {
      if (!pos[0]) fail("launch requires <bundle_id>");
      ok(simctl.launch(udid, pos[0], pos.slice(1)));
    }
    case "terminate": {
      if (!pos[0]) fail("terminate requires <bundle_id>");
      simctl.terminate(udid, pos[0]); ok({ ok: true });
    }
    case "logs": {
      const predicate = flags.predicate as string | undefined;
      if (flags.follow) {
        const code = await simctl.logStream(udid, predicate);
        process.exit(code);
      }
      const out = simctl.logShow(udid, { last: (flags.last as string) || "1m", predicate });
      process.stdout.write(out);
      process.exit(0);
    }
    case "screenshot": {
      const out = (flags.out as string) || join(tmpdir(), `ios-cli-${Date.now()}.png`);
      simctl.screenshot(udid, out);
      if (flags.base64) {
        const b64 = readFileSync(out).toString("base64");
        ok({ path: out, base64: b64 });
      }
      ok({ path: out });
    }
    case "describe": {
      const point = flags.point ? parsePoint(flags.point as string) : undefined;
      const tree = await withClient((c) => companion.describe(c, point));
      if (flags.screenshot) {
        const out = join(tmpdir(), `ios-cli-${Date.now()}.png`);
        simctl.screenshot(udid, out);
        const b64 = readFileSync(out).toString("base64");
        ok({ accessibility: tree, screenshot: { path: out, base64: b64 } });
      }
      ok({ accessibility: tree });
    }
    case "tap": {
      const [x, y] = [num(pos[0], "x"), num(pos[1], "y")];
      await withClient((c) => companion.tap(c, x, y, flags.duration ? Number(flags.duration) : undefined));
      ok({ ok: true });
    }
    case "swipe": {
      const [x1, y1, x2, y2] = [num(pos[0], "x1"), num(pos[1], "y1"), num(pos[2], "x2"), num(pos[3], "y2")];
      await withClient((c) =>
        companion.swipe(c, { x: x1, y: y1 }, { x: x2, y: y2 },
          flags.duration ? Number(flags.duration) : undefined,
          flags.delta ? Number(flags.delta) : undefined),
      );
      ok({ ok: true });
    }
    case "text": {
      if (!pos[0]) fail("text requires a string");
      await withClient((c) => companion.text(c, pos.join(" ")));
      ok({ ok: true });
    }
    case "button": {
      if (!pos[0]) fail("button requires a name");
      await withClient((c) => companion.button(c, pos[0]!, flags.duration ? Number(flags.duration) : undefined));
      ok({ ok: true });
    }
    default:
      fail(`Unknown command: ${cmd}`);
  }
}

function num(v: string | undefined, name: string): number {
  if (v === undefined || isNaN(Number(v))) fail(`${name} must be a number`);
  return Number(v);
}
function discoverCompanion(udid: string): string | undefined {
  // idb_companion writes /tmp/idb/<UDID>_companion.sock; pick a match or any if "booted".
  const dir = "/tmp/idb";
  if (!existsSync(dir)) return undefined;
  let entries: string[];
  try { entries = readdirSync(dir).filter((f) => f.endsWith("_companion.sock")); }
  catch { return undefined; }
  if (entries.length === 0) return undefined;
  const want = udid !== "booted" ? entries.find((f) => f.startsWith(udid)) : entries[0];
  return want ? `${dir}/${want}` : undefined;
}

function parsePoint(s: string): { x: number; y: number } {
  const [x, y] = s.split(",").map(Number);
  if (Number.isNaN(x) || Number.isNaN(y)) fail("--point must be x,y");
  return { x: x!, y: y! };
}

main().catch((e: Error) => fail(e.message || String(e)));
