#!/usr/bin/env bun
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as simctl from "./simctl.ts";
import * as companion from "./companion.ts";

type Flags = Record<string, string | boolean | string[]>;

// Flags whose values may repeat; collected as string[].
const MULTI_FLAGS = new Set(["env", "only", "skip"]);
// Boolean flags never consume the next arg, so positional args can follow them.
const BOOLEAN_FLAGS = new Set([
  "follow", "base64", "screenshot", "all",
  "no-build", "no-install", "no-terminate", "no-wait", "help",
  "verbose",
  "build-only",
]);
// Single-dash short flags mapped to their long-flag equivalents.
const SHORT_FLAGS: Record<string, string> = {
  v: "verbose",
};

function parse(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") || (a.length === 2 && a[0] === "-" && SHORT_FLAGS[a.slice(1)])) {
      const k = a.startsWith("--") ? a.slice(2) : SHORT_FLAGS[a.slice(1)]!;
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

/**
 * Read `LaunchAction → EnvironmentVariables` from an Xcode scheme. Accepts a
 * direct `.xcscheme` file path, or an `.xcodeproj` directory (in which case
 * the scheme inside `xcshareddata/xcschemes/` is picked — `<scheme>` if
 * provided, otherwise the only one). Returns `KEY → VAL` for entries with
 * `isEnabled="YES"`.
 */
function parseSchemeEnv(schemePath: string, schemeName?: string): Record<string, string> {
  let resolved = schemePath;
  if (existsSync(schemePath) && !schemePath.endsWith(".xcscheme")) {
    const dir = join(schemePath, "xcshareddata", "xcschemes");
    if (!existsSync(dir)) fail(`No xcshareddata/xcschemes in ${schemePath}`);
    const schemes = readdirSync(dir).filter((f) => f.endsWith(".xcscheme"));
    if (schemes.length === 0) fail(`No .xcscheme files in ${dir}`);
    const pick = schemeName ? schemes.find((s) => s === `${schemeName}.xcscheme`) : (schemes.length === 1 ? schemes[0] : undefined);
    if (!pick) fail(`Multiple schemes in ${dir}; pass --scheme-name <name>`);
    resolved = join(dir, pick);
  }
  if (!existsSync(resolved)) fail(`Scheme not found: ${resolved}`);
  const xml = readFileSync(resolved, "utf-8");
  const launch = xml.match(/<LaunchAction[\s\S]*?<\/LaunchAction>/)?.[0] ?? "";
  const out: Record<string, string> = {};
  const re = /<EnvironmentVariable\s+key\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"\s+isEnabled\s*=\s*"([^"]+)"/g;
  for (const m of launch.matchAll(re)) {
    if (m[3] === "YES") out[m[1]!] = m[2]!;
  }
  return out;
}

// Pretty-print to a TTY for humans; stay compact when piped/redirected for agents.
function encode(stream: NodeJS.WriteStream, data: unknown): string {
  return stream.isTTY ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}
function ok(data: unknown): never {
  if (data !== undefined) process.stdout.write(encode(process.stdout, data) + "\n");
  process.exit(0);
}
function fail(msg: string): never {
  process.stderr.write(encode(process.stderr, { error: msg }) + "\n");
  process.exit(1);
}

const HELP = `sim-cli — agent-friendly iOS simulator CLI

USAGE
  sim-cli [globals] <command> [args] [flags]

GLOBALS                                 (defaults shown; also via env)
  --udid <id|booted>                    target simulator           [IDB_UDID=booted]
  --companion <host:port>               idb companion endpoint     [IDB_COMPANION=localhost:10882]

DEVICE
  list-devices                          list all simulators
  list-apps                             list installed apps
  uninstall <bundle_id>                 remove app

APP LIFECYCLE
  run <bundle_id> [args...]             build → install → terminate prior → launch → wait
    --workspace <path>                  Xcode workspace            (auto-detected in CWD)
    --project <path>                    Xcode project              (auto-detected in CWD)
    --scheme-name <name>                build scheme               (auto-detected if only one)
    --configuration Debug|Release       build configuration        (Debug)
    --app <path>                        use prebuilt .app          (implies --no-build)
    --no-build                          skip xcodebuild; use newest in DerivedData
    --no-install                        use already-installed app
    --no-terminate                      don't kill prior instance
    --no-wait                           don't wait for frontmost
    --env KEY=VAL                       app env var                (repeatable)
    --scheme <path>                     read LaunchAction env from .xcscheme/.xcodeproj
  openurl <url>                         open URL / deep link

OBSERVE
  screenshot                            capture screen as PNG
    --out <file.png>                    output path                (tmp file)
    --base64                            also embed base64 in JSON
  describe                              return accessibility tree
    --point x,y                         tree at a single point
    --screenshot                        embed base64 PNG alongside
  logs                                  array of parsed ndjson entries; grep client-side
    --follow                            stream ndjson (one entry per line) until SIGINT
    --last <duration>                   lookback window            (1m)
    -v, --verbose                       include info+debug levels and Apple system subsystems

TEST
  test                                  xcodebuild test wrapper
    --workspace <path>                  Xcode workspace            (auto-detected in CWD)
    --project <path>                    Xcode project              (auto-detected in CWD)
    --scheme-name <name>                build scheme               (auto-detected if only one)
    --configuration Debug|Release       build configuration        (Debug)
    --only <Bundle/Class[/test]>        -only-testing identifier   (repeatable)
    --skip <Bundle/Class[/test]>        -skip-testing identifier   (repeatable)
    --build-only                        build-for-testing only
    --no-build                          test-without-building (assumes prior build)
    --result-bundle <path>              .xcresult output           (tmp file)
    --timeout <seconds>                 hard-kill xcodebuild after N seconds
  test-clone-logs                       read logs from the XCTestDevices clone
    --last <duration>                   lookback window            (1m)
    -v, --verbose                       include info+debug levels and Apple system subsystems

INTERACT
  tap <x> <y>                           tap at coordinates
  tap --label|--role|--text <s>         tap centroid of matched AX element
    --duration <s>                      hold duration
  swipe <x1> <y1> <x2> <y2>             swipe between points
    --duration <s>                      gesture duration
    --delta <n>                         gesture granularity
  type "<string>"                       send keystrokes to focused field
  press <home|lock|siri|side_button|apple_pay>
                                        press a hardware button
    --duration <s>                      hold duration

All commands write JSON to stdout on success and {"error": "..."} to stderr on failure.
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
    case "uninstall": {
      if (!pos[0]) fail("uninstall requires <bundle_id>");
      simctl.uninstall(udid, pos[0]); ok({ ok: true });
    }
    case "run": {
      if (!pos[0]) fail("run requires <bundle_id>");
      const bundle = pos[0];
      const noBuild = !!flags["no-build"] || !!flags.app;
      const noInstall = !!flags["no-install"];
      const noTerminate = !!flags["no-terminate"];
      const noWait = !!flags["no-wait"];

      let built: { workspace?: string; project?: string; scheme?: string } | undefined;
      if (!noBuild) {
        const container = (flags.workspace || flags.project)
          ? { workspace: flags.workspace as string | undefined, project: flags.project as string | undefined }
          : simctl.detectXcodeProject();
        if (!container.workspace && !container.project) {
          fail("No .xcworkspace/.xcodeproj found in CWD; pass --workspace, --project, or --no-build");
        }
        const scheme = (flags["scheme-name"] as string | undefined) ?? simctl.detectScheme(container);
        if (!scheme) fail("Could not auto-detect scheme; pass --scheme-name <name>");
        try {
          await simctl.build({ ...container, scheme, configuration: flags.configuration as string | undefined });
        } catch (e) {
          fail((e as Error).message);
        }
        built = { ...container, scheme };
      }

      const appPath = (flags.app as string) || simctl.findDerivedApp(bundle);
      if (!noInstall && !appPath) fail(`No build artifact found for ${bundle} in DerivedData; pass --app <path>`);

      if (!noTerminate) { try { simctl.terminate(udid, bundle); } catch {} }
      if (!noInstall && appPath) simctl.install(udid, appPath);

      const schemeEnv = flags.scheme ? parseSchemeEnv(flags.scheme as string, flags["scheme-name"] as string | undefined) : {};
      const env = { ...schemeEnv, ...parseEnvFlag(flags.env) };
      const result = simctl.launch(udid, bundle, pos.slice(1), { env });
      const ready = noWait ? undefined : await simctl.waitForRunning(udid, bundle);
      ok({ ...result, app: appPath, ...(ready !== undefined ? { ready } : {}), ...(built ? { built } : {}) });
    }
    case "test": {
      const container = (flags.workspace || flags.project)
        ? { workspace: flags.workspace as string | undefined, project: flags.project as string | undefined }
        : simctl.detectXcodeProject();
      if (!container.workspace && !container.project) {
        fail("No .xcworkspace/.xcodeproj found in CWD; pass --workspace or --project");
      }
      const scheme = (flags["scheme-name"] as string | undefined) ?? simctl.detectScheme(container);
      if (!scheme) fail("Could not auto-detect scheme; pass --scheme-name <name>");
      if (udid === "booted") {
        // xcodebuild test resolves a "booted" destination differently from
        // simctl; require an explicit UDID for reproducibility.
        const booted = simctl.listDevices() as any;
        const ids = collectBootedUdids(booted);
        if (ids.length !== 1) fail(`Pass --udid <id>; found ${ids.length} booted simulator(s)`);
      }
      const destUdid = udid === "booted" ? collectBootedUdids(simctl.listDevices())[0]! : udid;

      const only = asArray(flags.only);
      const skip = asArray(flags.skip);
      const result = await simctl.test({
        ...container,
        scheme: scheme!,
        destinationUdid: destUdid,
        configuration: flags.configuration as string | undefined,
        only,
        skip,
        resultBundlePath: flags["result-bundle"] as string | undefined,
        timeoutSec: flags.timeout ? Number(flags.timeout) : undefined,
        buildOnly: !!flags["build-only"],
        noBuild: !!flags["no-build"],
      });
      if (result.timedOut || result.failed > 0 || result.exitCode !== 0) {
        process.stdout.write(encode(process.stdout, result) + "\n");
        process.exit(result.timedOut ? 124 : (result.exitCode || 1));
      }
      ok(result);
    }
    case "test-clone-logs": {
      const clone = simctl.findTestCloneUdid();
      if (!clone) fail("No XCTestDevices clone found");
      const verbose = !!flags.verbose;
      const predicate = verbose ? undefined : `(subsystem == nil OR NOT subsystem BEGINSWITH "com.apple.")`;
      ok(simctl.logShowFromClone(clone, { last: (flags.last as string) || "1m", predicate, verbose }));
    }
    case "openurl": {
      if (!pos[0]) fail("openurl requires <url>");
      simctl.openurl(udid, pos[0]); ok({ ok: true });
    }
    case "logs": {
      const verbose = !!flags.verbose;
      // Drop Apple framework chatter (WebKit, runningboard, CFNetwork, …) by
      // default. `-v` lifts the filter and also includes info/debug levels.
      // No app-level filtering — agents grep the result for what they need.
      // NSPredicate quirk: `BEGINSWITH` on a nil subsystem yields nil, and
      // `NOT nil` is nil (falsy) — so a bare `NOT subsystem BEGINSWITH ...`
      // silently drops every entry without an explicit subsystem, which is
      // most native-app output. The `subsystem == nil` clause keeps those.
      // (ndjson renders nil as "" but the underlying predicate field is nil.)
      const predicate = verbose ? undefined : `(subsystem == nil OR NOT subsystem BEGINSWITH "com.apple.")`;
      if (flags.follow) {
        const code = await simctl.logStream(udid, predicate, { verbose });
        process.exit(code);
      }
      ok(simctl.logShow(udid, { last: (flags.last as string) || "1m", predicate, verbose }));
    }
    case "screenshot": {
      const out = (flags.out as string) || join(tmpdir(), `sim-cli-${Date.now()}.png`);
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
        const out = join(tmpdir(), `sim-cli-${Date.now()}.png`);
        simctl.screenshot(udid, out);
        const b64 = readFileSync(out).toString("base64");
        ok({ accessibility: tree, screenshot: { path: out, base64: b64 } });
      }
      ok({ accessibility: tree });
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
    case "type": {
      if (!pos[0]) fail("type requires a string");
      await withClient((c) => companion.text(c, pos.join(" ")));
      ok({ ok: true });
    }
    case "press": {
      if (!pos[0]) fail("press requires a button name");
      await withClient((c) => companion.button(c, pos[0]!, flags.duration ? Number(flags.duration) : undefined));
      ok({ ok: true });
    }
    default:
      fail(`Unknown command: ${cmd}`);
  }
}

function asArray(v: Flags[string]): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

function collectBootedUdids(devices: any): string[] {
  const out: string[] = [];
  const buckets = devices?.devices ?? {};
  for (const list of Object.values(buckets) as any[]) {
    for (const d of list) if (d?.state === "Booted" && d.udid) out.push(d.udid);
  }
  return out;
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
