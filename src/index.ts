#!/usr/bin/env bun
import { readFileSync, existsSync, mkdirSync, statSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import * as simctl from "./simctl.ts";
import * as companion from "./companion.ts";
import { resolveCompanion } from "./resolve.ts";

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

// Read `LaunchAction` env vars and command-line args from an Xcode scheme.
// `container` is a `.xcworkspace` or `.xcodeproj` path; `schemeName` picks the
// .xcscheme under `xcshareddata/xcschemes/`. Only entries with isEnabled="YES"
// are included.
function parseScheme(container: string, schemeName: string): { env: Record<string, string>; args: string[] } {
  const dir = join(container, "xcshareddata", "xcschemes");
  if (!existsSync(dir)) return { env: {}, args: [] };
  const path = join(dir, `${schemeName}.xcscheme`);
  if (!existsSync(path)) return { env: {}, args: [] };
  const xml = readFileSync(path, "utf-8");
  const launch = xml.match(/<LaunchAction[\s\S]*?<\/LaunchAction>/)?.[0] ?? "";
  const env: Record<string, string> = {};
  const envRe = /<EnvironmentVariable\s+key\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"\s+isEnabled\s*=\s*"([^"]+)"/g;
  for (const m of launch.matchAll(envRe)) {
    if (m[3] === "YES") env[m[1]!] = m[2]!;
  }
  const args: string[] = [];
  const argRe = /<CommandLineArgument\s+argument\s*=\s*"([^"]*)"\s+isEnabled\s*=\s*"([^"]+)"/g;
  for (const m of launch.matchAll(argRe)) {
    if (m[2] === "YES") args.push(m[1]!);
  }
  return { env, args };
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
                                        sim-cli owns one idb_companion per UDID and tracks it in
                                        ~/.sim-cli/companions.json. First use spawns; later uses
                                        reuse. No probing of unknown companions — that's how you
                                        get silent wrong-device bugs. Pass -v to log resolution.
                                        With "booted" and multiple booted sims, you must pass --udid.

ADVANCED
  --companion <host:port|unix:/sock>    pin a specific companion endpoint, bypassing autoresolve.
                                        Used as-is, not validated. For remote companions (physical
                                        devices, shared CI hosts). Local sim work uses --udid.  [IDB_COMPANION]

DEVICE
  list-devices                          list all simulators
  list-apps                             list installed apps
  uninstall <bundle_id>                 remove app
  pull <bundle_id> <src> [dest]         copy a file/dir out of an app's container;
                                        <src> is relative to the container root
    --container app|data                container kind             (data)
    --dest <dir>                        destination dir (alt. to positional)  (CWD)

APP LIFECYCLE
  run <bundle_id> [args...]             build → install → terminate prior → launch → wait
    --workspace <path>                  Xcode workspace            (auto-detected in CWD)
    --project <path>                    Xcode project              (auto-detected in CWD)
    --scheme <name>                     build scheme; also reads LaunchAction
                                        env vars + args from the matching
                                        .xcscheme                  (auto-detected if only one)
    --configuration Debug|Release       build configuration        (Debug)
    --app <path>                        use prebuilt .app          (implies --no-build)
    --no-build                          skip xcodebuild; use newest in DerivedData
    --no-install                        use already-installed app
    --no-terminate                      don't kill prior instance
    --no-wait                           don't wait for frontmost
    --env KEY=VAL                       app env var, overrides scheme value (repeatable)
  openurl <url>                         open URL / deep link

OBSERVE
  screenshot                            capture screen as PNG
    --out <file.png>                    output path                (tmp file)
    --base64                            also embed base64 in JSON
  describe                              return accessibility tree
    --point x,y                         tree at a single point
    --screenshot                        embed base64 PNG alongside
  wait --label|--role|--text|--id <s>   poll the AX tree until a node matches;
                                        prints the matched node, exits non-zero on timeout
    --timeout <ms>                      give up after N ms          (30000)
  logs                                  array of parsed ndjson entries; grep client-side
                                        default: info+ level, Apple subsystems & subsystem-less entries dropped
    --follow                            stream ndjson (one entry per line) until SIGINT
    --last <duration>                   lookback window            (1m)
    --subsystem <name>                  only entries from this os_log subsystem (exact match)
    -v, --verbose                       include debug level + Apple system subsystems + subsystem-less entries

TEST
  test                                  xcodebuild test wrapper
    --workspace <path>                  Xcode workspace            (auto-detected in CWD)
    --project <path>                    Xcode project              (auto-detected in CWD)
    --scheme <name>                     build scheme               (auto-detected if only one)
    --configuration Debug|Release       build configuration        (Debug)
    --only <Bundle/Class[/test]>        -only-testing identifier   (repeatable)
    --skip <Bundle/Class[/test]>        -skip-testing identifier   (repeatable)
    --build-only                        build-for-testing only
    --no-build                          test-without-building (assumes prior build)
    --result-bundle <path>              .xcresult output           (tmp file)
    --timeout <seconds>                 hard-kill xcodebuild after N seconds
  test-clone-logs                       read logs from the XCTestDevices clone
                                        same default filter as logs
    --last <duration>                   lookback window            (1m)
    -v, --verbose                       include debug level + Apple system subsystems + subsystem-less entries

INTERACT
  tap <x> <y>                           tap at coordinates
  tap --label|--role|--text|--id <s>    tap centroid of matched AX element
                                        --id matches accessibilityIdentifier (AXUniqueId).
                                        When multiple nodes match, actionable roles
                                        (AXButton, AXCell, …) win over AXStaticText.
    --wait <ms>                         poll up to N ms for the matcher to hit
    --duration <s>                      hold duration
  swipe <x1> <y1> <x2> <y2>             swipe between points
    --duration <s>                      gesture duration
    --delta <n>                         gesture granularity
  type "<string>"                       send keystrokes to focused field
  fill --label|--role|--text|--id <s> "<value>"
                                        tap a text field, wait for focus, then type.
                                        Bakes in the simulator's focus-animation settle.
    --wait <ms>                         poll up to N ms for the matcher to hit
    --settle <ms>                       focus-animation settle      (200)
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
  const explicitCompanion = (flags.companion as string) || process.env.IDB_COMPANION;
  const verbose = !!flags.verbose;

  // Resolve once per invocation, on first companion-touching command. Lazy so
  // simctl-only commands (list-devices, list-apps, …) don't pay the probe cost.
  let resolvedTarget: string | undefined;
  const getTarget = async (): Promise<string> => {
    if (resolvedTarget) return resolvedTarget;
    const r = await resolveCompanion({
      explicit: explicitCompanion,
      udid,
      log: (m) => { if (verbose) process.stderr.write(`sim-cli: ${m}\n`); },
    });
    resolvedTarget = r.endpoint;
    return resolvedTarget;
  };

  const withClient = async <T>(fn: (c: any) => Promise<T>): Promise<T> => {
    const target = await getTarget();
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
    case "pull": {
      if (!pos[0]) fail("pull requires <bundle_id> <src> [dest]");
      if (!pos[1]) fail("pull requires a <src> path relative to the app container");
      const kind = (flags.container as string) || "data";
      if (kind !== "app" && kind !== "data") fail("--container must be app or data");
      let base: string;
      try { base = simctl.getAppContainer(udid, pos[0], kind); }
      catch (e) { fail((e as Error).message); }
      const src = join(base, pos[1]);
      if (!existsSync(src)) fail(`not found in ${kind} container: ${pos[1]}`);
      const dest = pos[2] || (flags.dest as string) || process.cwd();
      mkdirSync(dest, { recursive: true });
      const files: string[] = [];
      if (statSync(src).isDirectory()) {
        // Copy the directory's contents (not the directory itself) into dest.
        for (const name of readdirSync(src)) {
          cpSync(join(src, name), join(dest, name), { recursive: true });
          files.push(name);
        }
      } else {
        const name = basename(src);
        cpSync(src, join(dest, name));
        files.push(name);
      }
      ok({ dest, files });
    }
    case "run": {
      if (!pos[0]) fail("run requires <bundle_id>");
      const bundle = pos[0];
      const noBuild = !!flags["no-build"] || !!flags.app;
      const noInstall = !!flags["no-install"];
      const noTerminate = !!flags["no-terminate"];
      const noWait = !!flags["no-wait"];

      // Resolve project + scheme up front so we can read LaunchAction env/args
      // from the .xcscheme regardless of whether we're building.
      const container = (flags.workspace || flags.project)
        ? { workspace: flags.workspace as string | undefined, project: flags.project as string | undefined }
        : simctl.detectXcodeProject();
      const scheme = (flags.scheme as string | undefined)
        ?? (container.workspace || container.project ? simctl.detectScheme(container) : undefined);

      let built: { workspace?: string; project?: string; scheme?: string } | undefined;
      if (!noBuild) {
        if (!container.workspace && !container.project) {
          fail("No .xcworkspace/.xcodeproj found in CWD; pass --workspace, --project, or --no-build");
        }
        if (!scheme) fail("Could not auto-detect scheme; pass --scheme <name>");
        try {
          await simctl.build({ ...container, scheme, configuration: flags.configuration as string | undefined });
        } catch (e) {
          fail((e as Error).message);
        }
        built = { ...container, scheme };
      }

      const appPath = (flags.app as string) || simctl.findDerivedApp(bundle);
      if (!noInstall && !appPath) fail(`No build artifact found for ${bundle} in DerivedData; pass --app <path>`);

      // install/launch require a booted sim; "booted" already implies one.
      if (udid !== "booted") {
        try { simctl.boot(udid); }
        catch (e) { fail((e as Error).message); }
      }

      if (!noTerminate) { try { simctl.terminate(udid, bundle); } catch {} }
      if (!noInstall && appPath) {
        // Concretize "booted" so the OS-version check picks the right device.
        const installUdid = udid === "booted" ? collectBootedUdids(simctl.listDevices())[0] ?? udid : udid;
        try { simctl.preflightInstallCompat(installUdid, appPath); }
        catch (e) { fail((e as Error).message); }
        simctl.install(udid, appPath);
      }

      const containerPath = container.workspace ?? container.project;
      const fromScheme = (containerPath && scheme) ? parseScheme(containerPath, scheme) : { env: {}, args: [] };
      const env = { ...fromScheme.env, ...parseEnvFlag(flags.env) };
      const launchArgs = [...fromScheme.args, ...pos.slice(1)];
      const result = simctl.launch(udid, bundle, launchArgs, { env });
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
      const scheme = (flags.scheme as string | undefined) ?? simctl.detectScheme(container);
      if (!scheme) fail("Could not auto-detect scheme; pass --scheme <name>");
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
      // Same iOS 26 stream-parser quirk as `logs`; keep predicates aligned.
      const predicate = verbose
        ? undefined
        : `subsystem MATCHES ".+" AND NOT subsystem BEGINSWITH "com.apple."`;
      ok(simctl.logShowFromClone(clone, { last: (flags.last as string) || "1m", predicate, verbose }));
    }
    case "openurl": {
      if (!pos[0]) fail("openurl requires <url>");
      simctl.openurl(udid, pos[0]); ok({ ok: true });
    }
    case "logs": {
      const verbose = !!flags.verbose;
      // Default mode keeps signal high enough that an agent's own `os_log`
      // calls aren't lost in the firehose:
      //   • Drop Apple framework chatter (WebKit, runningboard, CFNetwork, …).
      //   • Drop entries with no subsystem at all — printf-style fprintf from
      //     random daemons. ~25% of unfiltered volume on a typical tap.
      //   • Capture info+ (default `log stream` level is notice+, which hides
      //     most app debugging logs).
      // `-v` lifts every filter (Apple subsystems, empty subsystems, debug level)
      // for the rare case the noise itself is what you're after.
      // iOS 26 quirk: `log stream`'s predicate parser rejects `subsystem == nil`
      // and (more surprisingly) `subsystem != ""` is also a no-op — empty/absent
      // subsystems aren't filtered. `subsystem MATCHES ".+"` is the form that
      // actually drops them without crashing the parser. The ndjson rendering
      // confusingly shows "" for entries that the predicate sees as nil.
      // `--subsystem` pins the query to one os_log subsystem (e.g. an app's
      // own logs), overriding the default Apple-noise filter regardless of -v.
      const subsystem = flags.subsystem as string | undefined;
      if (subsystem && subsystem.includes('"')) fail("--subsystem must not contain quotes");
      const predicate = subsystem
        ? `subsystem == "${subsystem}"`
        : verbose
          ? undefined
          : `subsystem MATCHES ".+" AND NOT subsystem BEGINSWITH "com.apple."`;
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
      const q: Query = {
        label: flags.label as string | undefined,
        role: flags.role as string | undefined,
        text: flags.text as string | undefined,
        id: flags.id as string | undefined,
      };
      if (hasQuery(q)) {
        const wait = flags.wait ? Number(flags.wait) : 0;
        const m = await withClient(async (c) =>
          wait > 0 ? await pollMatch(c, q, wait) : findInTree(await companion.describe(c), q)[0]);
        if (!m) fail(wait > 0 ? `No element matched after ${wait}ms` : `No element matched`);
        x = m.x + m.w / 2;
        y = m.y + m.h / 2;
      } else {
        [x, y] = [num(pos[0], "x"), num(pos[1], "y")];
      }
      await withClient((c) => companion.tap(c, x, y, flags.duration ? Number(flags.duration) : undefined));
      ok({ ok: true, x, y });
    }
    case "wait": {
      const q: Query = {
        label: flags.label as string | undefined,
        role: flags.role as string | undefined,
        text: flags.text as string | undefined,
        id: flags.id as string | undefined,
      };
      if (!hasQuery(q)) fail("wait requires --label, --role, --text, or --id");
      const timeout = flags.timeout ? Number(flags.timeout) : 30_000;
      const m = await withClient((c) => pollMatch(c, q, timeout));
      if (!m) fail(`wait timed out after ${timeout}ms`);
      ok({ matched: m });
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
    case "fill": {
      const q: Query = {
        label: flags.label as string | undefined,
        role: flags.role as string | undefined,
        text: flags.text as string | undefined,
        id: flags.id as string | undefined,
      };
      if (!hasQuery(q)) fail("fill requires --label, --role, --text, or --id");
      if (!pos[0]) fail("fill requires a value");
      const value = pos.join(" ");
      const wait = flags.wait ? Number(flags.wait) : 0;
      const settle = flags.settle ? Number(flags.settle) : 200;
      await withClient(async (c) => {
        const m = wait > 0 ? await pollMatch(c, q, wait) : findInTree(await companion.describe(c), q)[0];
        if (!m) fail(wait > 0 ? `No element matched after ${wait}ms` : `No element matched`);
        await companion.tap(c, m.x + m.w / 2, m.y + m.h / 2);
        await new Promise((r) => setTimeout(r, settle));
        await companion.text(c, value);
      });
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
interface Match { x: number; y: number; w: number; h: number; role: string; label: string; id: string }

type Query = { label?: string; role?: string; text?: string; id?: string };

function hasQuery(q: Query): boolean {
  return !!(q.label || q.role || q.text || q.id);
}

function findInTree(tree: unknown, q: Query): Match[] {
  const results: Match[] = [];
  const wantLabel = q.label?.toLowerCase();
  const wantRole = q.role?.toLowerCase();
  const wantText = q.text?.toLowerCase();
  const wantId = q.id;
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    const label = String(n.AXLabel ?? n.label ?? "");
    const role = String(n.role ?? n.AXRole ?? "");
    const value = String(n.AXValue ?? n.value ?? "");
    const id = String(n.AXUniqueId ?? "");
    const fr = n.frame ?? {};
    const labelOk = wantLabel ? label.toLowerCase().includes(wantLabel) : true;
    const roleOk = wantRole ? role.toLowerCase().includes(wantRole) : true;
    const textOk = wantText ? (label + " " + value).toLowerCase().includes(wantText) : true;
    // accessibilityIdentifier is meant to be an exact key; substring match would
    // produce surprises across nodes that share a prefix.
    const idOk = wantId ? id === wantId : true;
    if (hasQuery(q) && labelOk && roleOk && textOk && idOk &&
        typeof fr.x === "number" && typeof fr.y === "number") {
      results.push({ x: fr.x, y: fr.y, w: fr.width ?? 0, h: fr.height ?? 0, role, label, id });
    }
    if (n.children) visit(n.children);
    // tree from `describe` is wrapped { accessibility: ... }; companion.describe returns the inner array/obj.
    for (const v of Object.values(n)) if (v && typeof v === "object") visit(v);
  };
  visit(tree);
  // dedupe by frame+label (Object.values traversal may revisit)
  const seen = new Set<string>();
  const deduped = results.filter((m) => {
    const k = `${m.x},${m.y},${m.w},${m.h},${m.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Prefer actionable nodes over headings: when SwiftUI wraps a Button around
  // a Text, both match the same label; the StaticText has no tap target.
  const inert = (role: string) => role === "AXStaticText" || role === "";
  return deduped.sort((a, b) => Number(inert(a.role)) - Number(inert(b.role)));
}

async function pollMatch(c: any, q: Query, timeoutMs: number): Promise<Match | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tree = await companion.describe(c);
    const m = findInTree(tree, q)[0];
    if (m) return m;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function parsePoint(s: string): { x: number; y: number } {
  const [x, y] = s.split(",").map(Number);
  if (Number.isNaN(x) || Number.isNaN(y)) fail("--point must be x,y");
  return { x: x!, y: y! };
}

main().catch((e: Error) => fail(e.message || String(e)));
