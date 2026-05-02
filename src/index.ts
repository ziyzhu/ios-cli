#!/usr/bin/env bun
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as simctl from "./simctl.ts";
import * as companion from "./companion.ts";

type Flags = Record<string, string | boolean | string[]>;

// Flags whose values may repeat; collected as string[].
const MULTI_FLAGS = new Set(["env"]);
// Boolean flags never consume the next arg, so positional args can follow them.
const BOOLEAN_FLAGS = new Set([
  "follow", "base64", "screenshot", "all",
  "terminate-running", "wait-for-frontmost", "help",
]);

function parse(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const isBool = BOOLEAN_FLAGS.has(k);
      const val = !isBool && next !== undefined && !next.startsWith("--")
        ? (i++, next)
        : true;
      if (MULTI_FLAGS.has(k)) {
        const cur = flags[k];
        const arr = Array.isArray(cur) ? cur : cur && typeof cur === "string" ? [cur] : [];
        if (typeof val === "string") arr.push(val);
        flags[k] = arr;
      } else {
        flags[k] = val;
      }
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift() ?? "";
  return { cmd, pos: positional, flags };
}

function parseEnvFlag(v: Flags["env"]): Record<string, string> {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out: Record<string, string> = {};
  for (const kv of arr) {
    const eq = kv.indexOf("=");
    if (eq <= 0) fail(`--env must be KEY=VAL (got ${kv})`);
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
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

Globals (any position): --udid <id|booted>  --companion <host:port>
  Defaults: booted, localhost:10882. Also reads IDB_UDID / IDB_COMPANION.

Commands:
  list-devices                          list all simulators (json)
  list-apps                             list installed apps (json)
  install <path>                        install .app/.ipa
  uninstall <bundle_id>
  launch <bundle_id> [args...]          returns {pid}
                                          [--env KEY=VAL]... pass env to app
                                          [--terminate-running] kill prior instance
                                          [--wait-for-frontmost] wait until app is registered
  run <bundle_id>                       build artifact → install → launch (waits for ready)
                                          [--app <path>] override DerivedData lookup
                                          [--env KEY=VAL]...
  terminate <bundle_id>
  logs [--follow] [--last 1m] [--predicate '<NSPredicate>']
                                        default returns {lines: [...]}; --follow streams raw text
  screenshot [--out file.png] [--base64]
  describe [--point x,y] [--screenshot] returns AX tree (+optional base64 png)
  find [--label <s>] [--role <s>] [--text <s>] [--all]
                                        return {x,y,w,h,role,label} of first match (or array)
  tap <x> <y> | --label <s>             [--duration s]
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
      const env = parseEnvFlag(flags.env);
      const result = simctl.launch(udid, pos[0], pos.slice(1), {
        env,
        terminateRunning: !!flags["terminate-running"],
      });
      if (flags["wait-for-frontmost"]) {
        const ready = await simctl.waitForRunning(udid, pos[0]);
        ok({ ...result, ready });
      }
      ok(result);
    }
    case "run": {
      if (!pos[0]) fail("run requires <bundle_id>");
      const bundle = pos[0];
      const appPath = (flags.app as string) || simctl.findDerivedApp(bundle);
      if (!appPath) fail(`No Debug build found for ${bundle} in DerivedData; pass --app <path>`);
      try { simctl.terminate(udid, bundle); } catch {}
      simctl.install(udid, appPath);
      const env = parseEnvFlag(flags.env);
      const result = simctl.launch(udid, bundle, pos.slice(1), { env });
      const ready = await simctl.waitForRunning(udid, bundle);
      ok({ ...result, app: appPath, ready });
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
      const lines = out.split("\n").filter((l) => l.length > 0);
      ok({ lines });
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
    case "find": {
      const tree = await withClient((c) => companion.describe(c));
      const matches = findInTree(tree, {
        label: flags.label as string | undefined,
        role: flags.role as string | undefined,
        text: flags.text as string | undefined,
      });
      if (flags.all) ok(matches);
      ok(matches[0] ?? null);
    }
    case "tap": {
      let x: number, y: number;
      if (flags.label || flags.role || flags.text) {
        const tree = await withClient((c) => companion.describe(c));
        const m = findInTree(tree, {
          label: flags.label as string | undefined,
          role: flags.role as string | undefined,
          text: flags.text as string | undefined,
        })[0];
        if (!m) fail(`No element matched`);
        x = m.x + m.w / 2;
        y = m.y + m.h / 2;
      } else {
        [x, y] = [num(pos[0], "x"), num(pos[1], "y")];
      }
      await withClient((c) => companion.tap(c, x, y, flags.duration ? Number(flags.duration) : undefined));
      ok({ ok: true, x, y });
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

interface Match { x: number; y: number; w: number; h: number; role: string; label: string }

function findInTree(
  tree: unknown,
  q: { label?: string; role?: string; text?: string },
): Match[] {
  const results: Match[] = [];
  const wantLabel = q.label?.toLowerCase();
  const wantRole = q.role?.toLowerCase();
  const wantText = q.text?.toLowerCase();
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    const label = String(n.AXLabel ?? n.label ?? "");
    const role = String(n.role ?? n.AXRole ?? "");
    const value = String(n.AXValue ?? n.value ?? "");
    const fr = n.frame ?? {};
    const labelOk = wantLabel ? label.toLowerCase().includes(wantLabel) : true;
    const roleOk = wantRole ? role.toLowerCase().includes(wantRole) : true;
    const textOk = wantText ? (label + " " + value).toLowerCase().includes(wantText) : true;
    if ((wantLabel || wantRole || wantText) && labelOk && roleOk && textOk &&
        typeof fr.x === "number" && typeof fr.y === "number") {
      results.push({ x: fr.x, y: fr.y, w: fr.width ?? 0, h: fr.height ?? 0, role, label });
    }
    if (n.children) visit(n.children);
    // tree from `describe` is wrapped { accessibility: ... }; companion.describe returns the inner array/obj.
    for (const v of Object.values(n)) if (v && typeof v === "object") visit(v);
  };
  visit(tree);
  // dedupe by frame+label (Object.values traversal may revisit)
  const seen = new Set<string>();
  return results.filter((m) => {
    const k = `${m.x},${m.y},${m.w},${m.h},${m.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parsePoint(s: string): { x: number; y: number } {
  const [x, y] = s.split(",").map(Number);
  if (Number.isNaN(x) || Number.isNaN(y)) fail("--point must be x,y");
  return { x: x!, y: y! };
}

main().catch((e: Error) => fail(e.message || String(e)));
