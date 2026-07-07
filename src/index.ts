#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as simctl from "./simctl.ts";
import * as companion from "./companion.ts";
import * as resolve from "./resolve.ts";
import { overview, commandHelp, agentContext, resolveSubcommand, resolveCommand, enumError, ENUMS } from "./help.ts";

type Flags = Record<string, string | boolean | string[]>;

const MULTI_FLAGS = new Set(["env"]);
const BOOLEAN_FLAGS = new Set([
  "base64", "screenshot", "help", "verbose",
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
    const idOk = wantId ? id === wantId : true;
    if (hasQuery(q) && labelOk && roleOk && textOk && idOk &&
        typeof fr.x === "number" && typeof fr.y === "number") {
      results.push({ x: fr.x, y: fr.y, w: fr.width ?? 0, h: fr.height ?? 0, role, label, id });
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
