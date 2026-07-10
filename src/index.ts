#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as simctl from "./simctl.ts";
import * as daemon from "./daemon.ts";
import * as proc from "./process.ts";
import * as companion from "./companion.ts";
import * as resolve from "./resolve.ts";
import { overview, commandHelp, agentContext, resolveSubcommand, resolveCommand, enumError, ENUMS } from "./help.ts";

type Flags = Record<string, string | boolean | string[]>;

const MULTI_FLAGS = new Set(["env"]);
const BOOLEAN_FLAGS = new Set([
  "base64", "screenshot", "help", "verbose", "missing", "replace", "watch", "vc",
]);
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(overview());
    process.exit(0);
  }
  const { cmd, pos, flags } = parse(argv);

  if (cmd === "help") {
    const detail = pos[0] ? commandHelp(pos[0]) : undefined;
    if (pos[0] && !detail) fail(`Unknown command: ${pos[0]}`);
    process.stdout.write(detail ?? overview());
    process.exit(0);
  }
  if (flags.help) {
    const detail = commandHelp(cmd);
    process.stdout.write(detail ?? overview());
    process.exit(0);
  }
  if (cmd === "agent-context") ok(agentContext());
  const deviceSpec = (flags.device as string) || (flags.udid as string)
    || process.env.SIM_DEVICE || process.env.IDB_UDID || "booted";
  let udid: string;
  try { udid = simctl.resolveDeviceSpec(deviceSpec); }
  catch (e) { fail((e as Error).message); }
  const explicitCompanion = (flags.companion as string) || process.env.IDB_COMPANION;
  const verbose = !!flags.verbose;

  let resolvedTarget: string | undefined;
  const getTarget = async (): Promise<string> => {
    if (resolvedTarget) return resolvedTarget;
    const r = await resolve.resolveCompanion({
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

  const resolveAppPid = (bundle: string): { udid: string; pid: number } => {
    const target = udid === "booted" ? soleBootedUdid() : udid;
    try { return { udid: target, pid: proc.resolvePid(target, bundle) }; }
    catch (e) { fail((e as Error).message); }
  };

  switch (cmd) {
    case "list-devices":
    case "devices": {
      const sub = pos[0] ? subcommandName("devices", pos[0]) : "list";
      if (sub === "list") ok(simctl.listDevices());
      if (sub === "rename") {
        if (!pos[1] || !pos[2]) fail("devices rename requires <device> <new_name>");
        try {
          const target = simctl.resolveDeviceSpec(pos[1]);
          simctl.rename(target, pos[2]);
          ok({ ok: true, udid: target, name: pos[2] });
        } catch (e) { fail((e as Error).message); }
      }
      if (sub === "clone") {
        if (!pos[1] || !pos[2]) fail("devices clone requires <source> <new_name>");
        try {
          const source = simctl.resolveDeviceSpec(pos[1]);
          const cloned = simctl.clone(source, pos[2]);
          ok({ ok: true, udid: cloned, name: pos[2], source });
        } catch (e) { fail((e as Error).message); }
      }
      if (sub === "boot") {
        if (!pos[1]) fail("devices boot requires <device>");
        try {
          const target = simctl.resolveDeviceSpec(pos[1]);
          simctl.bootAndWait(target);
          ok({ ok: true, udid: target, state: "Booted" });
        } catch (e) { fail((e as Error).message); }
      }
    }
    case "list-apps": ok(simctl.listApps(udid));
    case "uninstall": {
      if (!pos[0]) fail("uninstall requires <bundle_id>");
      simctl.uninstall(udid, pos[0]); ok({ ok: true });
    }
    case "file": {
      const sub = subcommandName("file", pos[0]);
      const bundle = pos[1];
      if (!bundle) fail(`file ${sub} requires <bundle_id>`);
      const kind = parseContainerKind(flags);
      try {
        if (sub === "list") {
          ok(simctl.fileLs(udid, bundle, pos[2] ?? "", kind));
        } else if (sub === "pull") {
          if (!pos[2]) fail("file pull requires <src> relative to container");
          const dest = pos[3] || (flags.dest as string) || process.cwd();
          ok({ dest, files: simctl.filePull(udid, bundle, pos[2], dest, kind) });
        } else if (sub === "push") {
          if (!pos[2] || !pos[3]) fail("file push requires <local_src> <container_dest>");
          simctl.filePush(udid, bundle, pos[2], pos[3], kind);
          ok({ ok: true });
        } else if (sub === "delete") {
          if (!pos[2]) fail("file delete requires <path>");
          simctl.fileRm(udid, bundle, pos[2], kind);
          ok({ ok: true });
        } else if (sub === "mkdir") {
          if (!pos[2]) fail("file mkdir requires <path>");
          simctl.fileMkdir(udid, bundle, pos[2], kind);
          ok({ ok: true });
        } else if (sub === "mv") {
          if (!pos[2] || !pos[3]) fail("file mv requires <src> <dest>");
          simctl.fileMv(udid, bundle, pos[2], pos[3], kind);
          ok({ ok: true });
        }
      } catch (e) { fail((e as Error).message); }
    }
    case "privacy": {
      const action = pos[0];
      if (!action || !ENUMS.privacyAction.includes(action as any)) {
        fail(enumError("privacy action", action ?? "", ENUMS.privacyAction));
      }
      const service = pos[1];
      if (!service) fail("privacy requires <service> after the action");
      if (!ENUMS.privacyService.includes(service as any)) {
        fail(enumError("privacy service", service, ENUMS.privacyService));
      }
      const bundle = pos[2];
      if ((action === "grant" || action === "revoke") && !bundle) {
        fail(`privacy ${action} requires <bundle_id>`);
      }
      try { simctl.privacy(udid, action as any, service, bundle); ok({ ok: true, action, service, ...(bundle ? { bundle } : {}) }); }
      catch (e) { fail((e as Error).message); }
    }
    case "appearance": {
      const mode = pos[0];
      if (mode !== "light" && mode !== "dark") fail(enumError("appearance", mode ?? "", ENUMS.appearance));
      try { simctl.setAppearance(udid, mode); ok({ ok: true, mode }); }
      catch (e) { fail((e as Error).message); }
    }
    case "clear-keychain": {
      try { simctl.clearKeychain(udid); ok({ ok: true }); }
      catch (e) { fail((e as Error).message); }
    }
    case "keychain": {
      const sub = subcommandName("keychain", pos[0]);
      try {
        if (sub === "reset") { simctl.clearKeychain(udid); ok({ ok: true }); }
        if (!pos[1]) fail(`keychain ${sub} requires <cert_path>`);
        simctl.keychainAddCert(udid, sub as "add-root-cert" | "add-cert", pos[1]);
        ok({ ok: true, action: sub, cert: pos[1] });
      } catch (e) { fail((e as Error).message); }
    }
    case "keyboard": {
      const sub = pos[0] ? subcommandName("keyboard", pos[0]) : "status";
      try {
        if (sub === "connect") simctl.setHardwareKeyboardConnected(true);
        if (sub === "disconnect") simctl.setHardwareKeyboardConnected(false);
        ok({ ok: true, connected: simctl.hardwareKeyboardConnected(), scope: "host" });
      } catch (e) { fail((e as Error).message); }
    }
    case "defaults": {
      const sub = subcommandName("defaults", pos[0]);
      const domain = pos[1];
      if (!domain) fail(`defaults ${sub} requires <domain>`);
      try {
        if (sub === "read") {
          ok({ domain, ...(pos[2] ? { key: pos[2] } : {}), value: simctl.defaultsRead(udid, domain, pos[2]) });
        } else if (sub === "write") {
          if (!pos[2] || pos[3] === undefined) fail("defaults write requires <domain> <key> <value>");
          const type = (flags.type as string | undefined) ?? "string";
          if (!ENUMS.defaultsType.includes(type as any)) fail(enumError("defaults type", type, ENUMS.defaultsType));
          simctl.defaultsWrite(udid, domain, pos[2], pos.slice(3).join(" "), type as any);
          ok({ ok: true, domain, key: pos[2], value: pos.slice(3).join(" "), type });
        } else if (sub === "delete") {
          simctl.defaultsDelete(udid, domain, pos[2]);
          ok({ ok: true, domain, ...(pos[2] ? { key: pos[2] } : {}) });
        }
      } catch (e) { fail((e as Error).message); }
    }
    case "pasteboard": {
      const sub = subcommandName("pasteboard", pos[0]);
      try {
        if (sub === "get") ok({ value: simctl.pasteboardGet(udid) });
        if (pos.length < 2) fail("pasteboard set requires <value>");
        const value = pos.slice(1).join(" ");
        simctl.pasteboardSet(udid, value);
        ok({ ok: true, value });
      } catch (e) { fail((e as Error).message); }
    }
    case "push": {
      let bundle: string | undefined;
      let payload: string | undefined;
      if (pos.length === 1) { payload = pos[0]; }
      else if (pos.length >= 2) { bundle = pos[0]; payload = pos[1]; }
      if (!payload) fail("push requires [<bundle_id>] <payload.json>");
      try { simctl.pushNotification(udid, bundle, payload); ok({ ok: true, ...(bundle ? { bundle } : {}), payload }); }
      catch (e) { fail((e as Error).message); }
    }
    case "record-video": {
      const sub = subcommandName("record-video", pos[0]);
      if (sub === "start") {
        const out = (flags.out as string) || join(tmpdir(), `sim-cli-${Date.now()}.mov`);
        try { ok(simctl.startRecordVideo(udid, out)); }
        catch (e) { fail((e as Error).message); }
      } else if (sub === "stop") {
        ok(simctl.stopRecordVideo(udid));
      }
    }
    case "status-bar": {
      const sub = subcommandName("status-bar", pos[0]);
      if (sub === "clear") {
        try { simctl.statusBarClear(udid); ok({ ok: true }); }
        catch (e) { fail((e as Error).message); }
      } else if (sub === "override") {
        const keys = ["time", "dataNetwork", "wifiMode", "wifiBars", "cellularMode", "cellularBars", "operatorName", "batteryState", "batteryLevel"];
        const opts: Record<string, string> = {};
        for (const k of keys) if (typeof flags[k] === "string") opts[k] = flags[k] as string;
        if (Object.keys(opts).length === 0) fail("status-bar override requires at least one flag (--time, --batteryLevel, ...)");
        try { simctl.statusBarOverride(udid, opts); ok({ ok: true, opts }); }
        catch (e) { fail((e as Error).message); }
      }
    }
    case "crash": {
      const sub = subcommandName("crash", pos[0]);
      if (sub === "list") {
        ok(simctl.listCrashes({ bundle: flags.bundle as string | undefined }));
      } else if (sub === "show") {
        if (!pos[1]) fail("crash show requires <name>");
        try { process.stdout.write(simctl.showCrash(pos[1])); process.exit(0); }
        catch (e) { fail((e as Error).message); }
      } else if (sub === "delete") {
        if (!pos[1]) fail("crash delete requires <name>");
        try { simctl.deleteCrash(pos[1]); ok({ ok: true }); }
        catch (e) { fail((e as Error).message); }
      }
    }
    case "stats": {
      if (!pos[0]) fail("stats requires <bundle_id>");
      const { udid: target, pid } = resolveAppPid(pos[0]);
      if (flags.watch) {
        let prev = proc.rusage(pid);
        let prevAt = performance.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          let cur: proc.Rusage;
          try { cur = proc.rusage(pid); }
          catch { process.stdout.write(JSON.stringify({ pid, exited: true }) + "\n"); process.exit(0); }
          const now = performance.now();
          process.stdout.write(JSON.stringify({ pid, ...proc.gaugesDelta(prev, cur, now - prevAt) }) + "\n");
          prev = cur;
          prevAt = now;
        }
      }
      const g = await proc.gauges(pid, 500);
      const net = proc.netTotals(pid);
      let containerMb: number | undefined;
      try { containerMb = proc.duMb(simctl.getAppContainer(target, pos[0])); } catch {}
      ok({
        pid, scope: "app-process-only", ...g,
        ...(net ? { netRxBytes: net.rxBytes, netTxBytes: net.txBytes } : {}),
        ...(containerMb !== undefined ? { containerMb } : {}),
      });
    }
    case "hierarchy": {
      if (!pos[0]) fail("hierarchy requires <bundle_id>");
      const { pid } = resolveAppPid(pos[0]);
      try {
        const text = flags.vc ? proc.vcHierarchy(pid) : proc.viewHierarchy(pid);
        const out = (flags.out as string) || join(tmpdir(), `sim-cli-hierarchy-${Date.now()}.txt`);
        writeFileSync(out, text + "\n");
        ok({ pid, path: out, lines: text.split("\n").length });
      } catch (e) { fail((e as Error).message); }
    }
    case "memory": {
      const subGiven = pos[0] ? resolveSubcommand(resolveCommand("memory")!, pos[0]) : undefined;
      const sub = subGiven?.name ?? "footprint";
      if (sub === "warn") {
        try { await withClient((c) => companion.simulateMemoryWarning(c)); ok({ ok: true, warned: true }); }
        catch (e) { fail((e as Error).message); }
      }
      const bundle = subGiven ? pos[1] : pos[0];
      if (!bundle) fail(`memory ${sub} requires <bundle_id>`);
      const { pid } = resolveAppPid(bundle);
      try {
        if (sub === "leaks") {
          const scan = proc.leaksScan(pid);
          const out = (flags.out as string) || join(tmpdir(), `sim-cli-leaks-${Date.now()}.txt`);
          writeFileSync(out, scan.report);
          ok({ pid, leakCount: scan.leakCount, leakedBytes: scan.leakedBytes, path: out });
        }
        ok({ pid, ...proc.footprint(pid) });
      } catch (e) { fail((e as Error).message); }
    }
    case "sample": {
      if (!pos[0]) fail("sample requires <bundle_id>");
      const duration = flags.duration ? Number(flags.duration) : 2;
      const { pid } = resolveAppPid(pos[0]);
      const out = (flags.out as string) || join(tmpdir(), `sim-cli-sample-${Date.now()}.txt`);
      try { ok({ pid, duration, path: out, topOfStack: proc.samplePid(pid, duration, out) }); }
      catch (e) { fail((e as Error).message); }
    }
    case "run": {
      if (!pos[0]) fail("run requires <bundle_id>");
      const bundle = pos[0];
      const prebuilt = flags.app as string | undefined;

      const container = (flags.workspace || flags.project)
        ? { workspace: flags.workspace as string | undefined, project: flags.project as string | undefined }
        : simctl.detectXcodeProject();
      const scheme = (flags.scheme as string | undefined)
        ?? (container.workspace || container.project ? simctl.detectScheme(container) : undefined);

      let built: { workspace?: string; project?: string; scheme?: string } | undefined;
      if (!prebuilt) {
        if (!container.workspace && !container.project) {
          fail("No .xcworkspace/.xcodeproj found in CWD; pass --workspace, --project, or --app");
        }
        if (!scheme) fail("Could not auto-detect scheme; pass --scheme <name>");
        try {
          await simctl.build({ ...container, scheme, configuration: flags.configuration as string | undefined });
        } catch (e) {
          fail((e as Error).message);
        }
        built = { ...container, scheme };
      }

      const appPath = prebuilt || simctl.findDerivedApp(bundle);
      if (!appPath) fail(`No build artifact found for ${bundle} in DerivedData; pass --app <path>`);

      if (udid !== "booted") {
        try { simctl.boot(udid); }
        catch (e) { fail((e as Error).message); }
      }
      const targetUdid = concreteUdid(udid);

      try { simctl.terminate(udid, bundle); } catch {}
      try { simctl.preflightInstallCompat(targetUdid, appPath); }
      catch (e) { fail((e as Error).message); }
      simctl.install(udid, appPath);

      const containerPath = container.workspace ?? container.project;
      const fromScheme = (containerPath && scheme) ? parseScheme(containerPath, scheme) : { env: {}, args: [] };
      const env = { ...fromScheme.env, ...parseEnvFlag(flags.env) };
      const launchArgs = [...fromScheme.args, ...pos.slice(1)];
      const result = simctl.launch(udid, bundle, launchArgs, { env });
      const ready = await simctl.waitForRunning(udid, bundle);
      let logs: { pid: number; file: string } | undefined;
      try { logs = simctl.startLogCapture(targetUdid, { verbose: true }); }
      catch (e) { process.stderr.write(encode(process.stderr, { warn: `log capture failed: ${(e as Error).message}` }) + "\n"); }
      ok({ ...result, app: appPath, ready, ...(logs ? { logs } : {}), ...(built ? { built } : {}) });
    }
    case "daemon": {
      const port = flags.port ? Number(flags.port) : daemon.DEFAULT_PORT;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) fail("--port must be a valid TCP port");
      daemon.startDaemon(port);
      return;
    }
    case "config": {
      ok({
        dir: resolve.STATE_DIR,
        companions: resolve.readRegistry(),
        captures: simctl.listCaptures(),
      });
    }
    case "logs": {
      const all = simctl.listCaptures();
      const filter = flags.device || flags.udid ? concreteUdid(udid) : undefined;
      ok(filter ? all.filter((c) => c.udid === filter) : all);
    }
    case "openurl": {
      if (!pos[0]) fail("openurl requires <url>");
      simctl.openurl(udid, pos[0]); ok({ ok: true });
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
    case "wait": {
      const q = queryFromFlags(flags);
      if (!hasQuery(q)) fail("wait requires --label, --role, --text, or --id");
      const timeout = flags.timeout ? Number(flags.timeout) : 5000;
      const stable = flags.stable ? Number(flags.stable) : 0;
      if (flags.missing) {
        const gone = await withClient((c) => pollMissing(c, q, timeout, stable));
        if (!gone) fail(`Element still matched after ${timeout}ms`);
        ok({ ok: true, missing: true });
      }
      const match = await withClient((c) => pollMatch(c, q, timeout, { stableMs: stable }));
      if (!match) fail(`No element matched after ${timeout}ms`);
      ok({ ok: true, match });
    }
    case "tap": {
      const q = queryFromFlags(flags);
      const duration = flags.duration ? Number(flags.duration) : undefined;
      const settle = flags.settle ? Number(flags.settle) : 0;
      if (hasQuery(q)) {
        const wait = flags.wait ? Number(flags.wait) : 0;
        const stable = flags.stable ? Number(flags.stable) : 0;
        const result = await withClient(async (c) => {
          const m = await pollMatch(c, q, wait > 0 ? wait : Math.max(1000, stable + 500), {
            stableMs: stable,
            hittable: true,
          });
          if (!m) return undefined;
          const x = m.x + m.w / 2;
          const y = m.y + m.h / 2;
          await companion.tap(c, x, y, duration);
          if (settle > 0) await new Promise((r) => setTimeout(r, settle));
          return { x, y, match: m };
        });
        const m = result?.match;
        if (!m) fail(wait > 0 ? `No element matched after ${wait}ms` : `No element matched`);
        ok({ ok: true, x: result!.x, y: result!.y, match: m });
      }
      const [x, y] = [num(pos[0], "x"), num(pos[1], "y")];
      await withClient(async (c) => {
        await companion.tap(c, x, y, duration);
        if (settle > 0) await new Promise((r) => setTimeout(r, settle));
      });
      ok({ ok: true, x, y });
    }
    case "swipe": {
      const direction = flags.direction as string | undefined;
      const duration = flags.duration ? Number(flags.duration) : undefined;
      const delta = flags.delta ? Number(flags.delta) : undefined;
      if (direction) {
        if (!ENUMS.direction.includes(direction as any)) fail(enumError("swipe direction", direction, ENUMS.direction));
        const edge = flags.edge as string | undefined;
        if (edge && !ENUMS.edge.includes(edge as any)) fail(enumError("swipe edge", edge, ENUMS.edge));
        const distance = flags.distance ? Number(flags.distance) : 0.55;
        if (!(distance > 0 && distance <= 0.9)) fail("--distance must be greater than 0 and at most 0.9");
        const q = queryFromFlags(flags);
        const points = await withClient(async (c) => {
          const tree = await companion.describe(c);
          const frame = hasQuery(q) ? findInTree(tree, q, { visibleOnly: true })[0] : applicationFrame(tree);
          if (!frame) fail(hasQuery(q) ? "No swipe anchor matched" : "Could not determine screen frame");
          const gesture = relativeSwipe(frame, direction as any, edge as any, distance);
          await companion.swipe(c, gesture.start, gesture.end, duration, delta);
          return gesture;
        });
        ok({ ok: true, ...points });
      }
      const [x1, y1, x2, y2] = [num(pos[0], "x1"), num(pos[1], "y1"), num(pos[2], "x2"), num(pos[3], "y2")];
      await withClient((c) => companion.swipe(c, { x: x1, y: y1 }, { x: x2, y: y2 }, duration, delta));
      ok({ ok: true, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
    }
    case "type": {
      if (!pos[0]) fail("type requires a string");
      await withClient((c) => companion.text(c, pos.join(" ")));
      ok({ ok: true });
    }
    case "fill": {
      const q = queryFromFlags(flags);
      if (!hasQuery(q)) fail("fill requires --label, --role, --text, or --id");
      if (!pos[0]) fail("fill requires a value");
      const value = pos.join(" ");
      const wait = flags.wait ? Number(flags.wait) : 0;
      const settle = flags.settle ? Number(flags.settle) : 200;
      const result = await withClient(async (c) => {
        const m = await pollMatch(c, q, wait > 0 ? wait : 1000, { hittable: true });
        if (!m) fail(wait > 0 ? `No element matched after ${wait}ms` : `No element matched`);
        await companion.tap(c, m.x + m.w / 2, m.y + m.h / 2);
        await new Promise((r) => setTimeout(r, settle));
        const replace = !!flags.replace;
        if (replace) await companion.replaceText(c, value);
        else await companion.text(c, value);
        const refind = async (): Promise<Match | undefined> => {
          const tree = await companion.describe(c);
          if (m.id) {
            const byId = findInTree(tree, { id: m.id }, { visibleOnly: true })[0];
            if (byId) return byId;
          }
          const byQuery = findInTree(tree, q, { visibleOnly: true })[0];
          if (byQuery) return byQuery;
          if (!m.role) return undefined;
          return findInTree(tree, { role: m.role }, { visibleOnly: true }).find((e) => Math.abs(e.x - m.x) < 2 && Math.abs(e.y - m.y) < 2);
        };
        const landed = (v: string | undefined) => !!v && (replace ? v === value : v.toLowerCase().includes(value.toLowerCase()));
        let after = await refind();
        let retried = false;
        if (after && !landed(after.value) && after.value === m.value) {
          retried = true;
          await new Promise((r) => setTimeout(r, Math.max(settle * 4, 1000)));
          if (replace) await companion.replaceText(c, value);
          else await companion.text(c, value);
          after = await refind();
        }
        return {
          ok: true,
          verified: landed(after?.value),
          ...(after ? { value: after.value } : {}),
          ...(retried ? { retried } : {}),
        };
      });
      ok(result);
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

function parseContainerKind(flags: Flags): "app" | "data" {
  const k = (flags.container as string) || "data";
  if (k !== "app" && k !== "data") fail(enumError("--container", k, ENUMS.container));
  return k;
}

function subcommandName(command: string, given: string | undefined): string {
  const c = resolveCommand(command)!;
  const valid = c.subcommands!.map((s) => s.name);
  if (!given) fail(`${command} requires <${valid.join("|")}>`);
  const sub = resolveSubcommand(c, given);
  if (!sub) fail(enumError(`${command} subcommand`, given, valid));
  return sub.name;
}

function concreteUdid(udid: string): string {
  return udid === "booted" ? collectBootedUdids(simctl.listDevices())[0] ?? udid : udid;
}

function soleBootedUdid(): string {
  const booted = collectBootedUdids(simctl.listDevices());
  if (booted.length === 1) return booted[0]!;
  fail(booted.length === 0 ? "no simulator is booted" : `${booted.length} simulators are booted; pass --device`);
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
interface Match { x: number; y: number; w: number; h: number; role: string; label: string; id: string; value: string }

type Query = { label?: string; role?: string; text?: string; id?: string };

type Frame = { x: number; y: number; w: number; h: number };

function queryFromFlags(flags: Flags): Query {
  return {
    label: flags.label as string | undefined,
    role: flags.role as string | undefined,
    text: flags.text as string | undefined,
    id: flags.id as string | undefined,
  };
}

function hasQuery(q: Query): boolean {
  return !!(q.label || q.role || q.text || q.id);
}

function applicationFrame(tree: unknown): Frame | undefined {
  let found: Frame | undefined;
  const visit = (n: any) => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const child of n) visit(child); return; }
    const role = String(n.role ?? n.AXRole ?? "");
    const frame = n.frame ?? {};
    if (role === "AXApplication" && typeof frame.x === "number" && typeof frame.y === "number" && frame.width > 0 && frame.height > 0) {
      found = { x: frame.x, y: frame.y, w: frame.width, h: frame.height };
      return;
    }
    for (const value of Object.values(n)) if (value && typeof value === "object") visit(value);
  };
  visit(tree);
  return found;
}

function findInTree(tree: unknown, q: Query, opts: { visibleOnly?: boolean } = {}): Match[] {
  const results: Match[] = [];
  const screen = opts.visibleOnly ? applicationFrame(tree) : undefined;
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
    const text = [label, value, n.title, n.help, ...(Array.isArray(n.custom_actions) ? n.custom_actions : [])].filter(Boolean).join(" ");
    const fr = n.frame ?? {};
    const labelOk = wantLabel ? label.toLowerCase().includes(wantLabel) : true;
    const roleOk = wantRole ? role.toLowerCase().includes(wantRole) : true;
    const textOk = wantText ? text.toLowerCase().includes(wantText) : true;
    const idOk = wantId ? id === wantId : true;
    if (hasQuery(q) && labelOk && roleOk && textOk && idOk && typeof fr.x === "number" && typeof fr.y === "number") {
      const match = { x: fr.x, y: fr.y, w: fr.width ?? 0, h: fr.height ?? 0, role, label, id, value };
      const onscreen = !screen || (
        match.w > 0 && match.h > 0
        && match.x < screen.x + screen.w && match.x + match.w > screen.x
        && match.y < screen.y + screen.h && match.y + match.h > screen.y
      );
      if (onscreen) results.push(match);
    }
    if (n.children) visit(n.children);
    for (const v of Object.values(n)) if (v && typeof v === "object") visit(v);
  };
  visit(tree);
  const seen = new Set<string>();
  const deduped = results.filter((m) => {
    const k = `${m.x},${m.y},${m.w},${m.h},${m.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const inert = (role: string) => role === "AXStaticText" || role === "";
  return deduped.sort((a, b) => Number(inert(a.role)) - Number(inert(b.role)));
}

function matchSignature(match: Match): string {
  return [match.x, match.y, match.w, match.h, match.role, match.label, match.id, match.value].join("\u0000");
}

async function matchIsHittable(c: any, q: Query, match: Match): Promise<boolean> {
  const x = match.x + match.w / 2;
  const y = match.y + match.h / 2;
  const tree = await companion.describe(c, { x, y });
  return findInTree(tree, q).length > 0;
}

async function pollMatch(
  c: any,
  q: Query,
  timeoutMs: number,
  opts: { stableMs?: number; hittable?: boolean } = {},
): Promise<Match | undefined> {
  const deadline = Date.now() + timeoutMs;
  let signature = "";
  let stableSince = 0;
  for (;;) {
    const tree = await companion.describe(c);
    const match = findInTree(tree, q, { visibleOnly: true })[0];
    if (match) {
      const nextSignature = matchSignature(match);
      if (nextSignature !== signature) {
        signature = nextSignature;
        stableSince = Date.now();
      }
      const stable = Date.now() - stableSince >= (opts.stableMs ?? 0);
      if (stable && (!opts.hittable || await matchIsHittable(c, q, match))) return match;
    } else {
      signature = "";
      stableSince = 0;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function pollMissing(c: any, q: Query, timeoutMs: number, stableMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let missingSince = 0;
  for (;;) {
    const matches = findInTree(await companion.describe(c), q, { visibleOnly: true });
    if (matches.length === 0) {
      if (missingSince === 0) missingSince = Date.now();
      if (Date.now() - missingSince >= stableMs) return true;
    } else {
      missingSince = 0;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function relativeSwipe(
  frame: Frame,
  direction: "up" | "down" | "left" | "right",
  edge: "left" | "right" | "top" | "bottom" | undefined,
  distance: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const insetX = Math.max(4, frame.w * 0.04);
  const insetY = Math.max(4, frame.h * 0.04);
  const minX = frame.x + insetX;
  const maxX = frame.x + frame.w - insetX;
  const minY = frame.y + insetY;
  const maxY = frame.y + frame.h - insetY;
  const center = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  const vector = direction === "up" ? { x: 0, y: -1 }
    : direction === "down" ? { x: 0, y: 1 }
    : direction === "left" ? { x: -1, y: 0 }
    : { x: 1, y: 0 };
  const travel = (vector.x === 0 ? frame.h : frame.w) * distance;
  const start = edge === "left" ? { x: minX, y: center.y }
    : edge === "right" ? { x: maxX, y: center.y }
    : edge === "top" ? { x: center.x, y: minY }
    : edge === "bottom" ? { x: center.x, y: maxY }
    : { x: center.x - vector.x * travel / 2, y: center.y - vector.y * travel / 2 };
  const end = { x: start.x + vector.x * travel, y: start.y + vector.y * travel };
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  return {
    start: { x: clamp(start.x, minX, maxX), y: clamp(start.y, minY, maxY) },
    end: { x: clamp(end.x, minX, maxX), y: clamp(end.y, minY, maxY) },
  };
}

function parsePoint(s: string): { x: number; y: number } {
  const [x, y] = s.split(",").map(Number);
  if (Number.isNaN(x) || Number.isNaN(y)) fail("--point must be x,y");
  return { x: x!, y: y! };
}

main().catch((e: Error) => fail(e.message || String(e)));
