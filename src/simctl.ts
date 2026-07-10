import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, renameSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type Udid = string | "booted";

function run(args: string[], env?: NodeJS.ProcessEnv, input?: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8", env, input });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function ok(args: string[], env?: NodeJS.ProcessEnv): string {
  const r = run(args, env);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `simctl ${args[0]} failed`);
  return r.stdout;
}

export function listDevices(): unknown {
  const out = ok(["list", "-j", "devices"]);
  return JSON.parse(out);
}

const UDID_RE = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

export function resolveDeviceSpec(spec: string): string {
  if (spec === "booted" || UDID_RE.test(spec)) return spec;
  const buckets = (listDevices() as any)?.devices ?? {};
  const matches: { udid: string; name: string; state: string; runtime: string }[] = [];
  for (const [runtimeId, list] of Object.entries(buckets) as [string, any[]][]) {
    for (const d of list) {
      if (d?.isAvailable !== false && d?.name?.toLowerCase() === spec.toLowerCase()) {
        matches.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtimeId.split(".").pop() ?? runtimeId });
      }
    }
  }
  if (matches.length === 1) return matches[0]!.udid;
  const booted = matches.filter((m) => m.state === "Booted");
  if (booted.length === 1) return booted[0]!.udid;
  if (matches.length === 0) throw new Error(`no simulator named "${spec}"; see \`sim-cli devices\``);
  throw new Error(
    `"${spec}" matches ${matches.length} simulators: ` +
    matches.map((m) => `${m.udid} [${m.runtime}, ${m.state}]`).join(", ") +
    "; pass --device <udid>",
  );
}

export function rename(udid: Udid, name: string): void {
  ok(["rename", udid, name]);
}

export function clone(udid: Udid, name: string): string {
  return ok(["clone", udid, name]).trim();
}

export function bootAndWait(udid: Udid): void {
  boot(udid);
  ok(["bootstatus", udid, "-b"]);
}

export function defaultsRead(udid: Udid, domain: string, key?: string): string {
  return ok(["spawn", udid, "defaults", "read", domain, ...(key ? [key] : [])]).trim();
}

export function defaultsWrite(
  udid: Udid,
  domain: string,
  key: string,
  value: string,
  type: "bool" | "string" | "int" | "float" = "string",
): void {
  const flag = type === "int" ? "-int" : `-${type}`;
  ok(["spawn", udid, "defaults", "write", domain, key, flag, value]);
}

export function defaultsDelete(udid: Udid, domain: string, key?: string): void {
  ok(["spawn", udid, "defaults", "delete", domain, ...(key ? [key] : [])]);
}

export function pasteboardGet(udid: Udid): string {
  return ok(["pbpaste", udid]);
}

export function pasteboardSet(udid: Udid, value: string): void {
  const r = run(["pbcopy", udid], undefined, value);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "simctl pbcopy failed");
}

export function hardwareKeyboardConnected(): boolean {
  const r = spawnSync("defaults", ["read", "com.apple.iphonesimulator", "ConnectHardwareKeyboard"], { encoding: "utf8" });
  if (r.status !== 0) return false;
  return ["1", "true", "yes"].includes(r.stdout.trim().toLowerCase());
}

export function setHardwareKeyboardConnected(connected: boolean): void {
  const r = spawnSync("defaults", ["write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", connected ? "true" : "false"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "could not update Simulator keyboard preference");
}

export function listApps(udid: Udid): unknown {
  const r = spawnSync(
    "bash",
    ["-c", `xcrun simctl listapps ${udid} | plutil -convert json -o - -`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "listapps failed");
  return JSON.parse(r.stdout);
}

export function install(udid: Udid, path: string): void {
  ok(["install", udid, path]);
}

export function uninstall(udid: Udid, bundleId: string): void {
  ok(["uninstall", udid, bundleId]);
}

export function getAppContainer(udid: Udid, bundleId: string, kind = "data"): string {
  return ok(["get_app_container", udid, bundleId, kind]).trim();
}

export function boot(udid: Udid): void {
  const r = run(["boot", udid]);
  if (r.code !== 0 && !/current state: Booted/.test(r.stderr)) {
    throw new Error(r.stderr.trim() || "boot failed");
  }
}

export function appMinimumOSVersion(appPath: string): string | undefined {
  const plist = `${appPath}/Info.plist`;
  const r = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :MinimumOSVersion", plist], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const v = r.stdout.trim();
  return v || undefined;
}

export function deviceRuntime(udid: string): { name?: string; osVersion?: string } | undefined {
  let devices: any;
  try { devices = listDevices() as any; } catch { return undefined; }
  for (const [runtimeId, list] of Object.entries(devices?.devices ?? {}) as [string, any[]][]) {
    for (const d of list) {
      if (d?.udid === udid) {
        const m = runtimeId.match(/iOS-(\d+(?:-\d+)*)/);
        const osVersion = m ? m[1]!.replaceAll("-", ".") : undefined;
        return { name: d.name, osVersion };
      }
    }
  }
  return undefined;
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function preflightInstallCompat(udid: string, appPath: string): void {
  const need = appMinimumOSVersion(appPath);
  if (!need) return;
  const dev = deviceRuntime(udid);
  if (!dev?.osVersion) return;
  if (cmpVersion(dev.osVersion, need) >= 0) return;
  const who = dev.name ? `${dev.name} (${udid})` : udid;
  throw new Error(`incompatible: ${appPath.split("/").pop()} requires iOS ${need}, ${who} runs iOS ${dev.osVersion}; pick a sim on iOS ${need} or higher`);
}

export function launch(
  udid: Udid,
  bundleId: string,
  args: string[],
  opts: { env?: Record<string, string>; terminateRunning?: boolean } = {},
): { pid: number } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) env[`SIMCTL_CHILD_${k}`] = v;
  const flags: string[] = [];
  if (opts.terminateRunning) flags.push("--terminate-running-process");
  const out = ok(["launch", ...flags, udid, bundleId, ...args], env);
  const m = out.match(/:\s*(\d+)/);
  return { pid: m ? parseInt(m[1]!, 10) : 0 };
}

export async function waitForRunning(
  udid: Udid,
  bundleId: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const needle = `UIKitApplication:${bundleId}`;
  while (Date.now() < deadline) {
    const r = spawnSync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.includes(needle)) return true;
    await new Promise((res) => setTimeout(res, 150));
  }
  return false;
}

export function terminate(udid: Udid, bundleId: string): void {
  ok(["terminate", udid, bundleId]);
}

export function openurl(udid: Udid, url: string): void {
  ok(["openurl", udid, url]);
}

export function screenshot(udid: Udid, outPath: string): void {
  ok(["io", udid, "screenshot", outPath]);
}

const LOG_CAPTURE_DIR = join(homedir(), ".sim-cli", "logs");

export function logCapturePaths(udid: Udid): { dir: string; file: string; pidFile: string } {
  return {
    dir: LOG_CAPTURE_DIR,
    file: join(LOG_CAPTURE_DIR, `${udid}.log`),
    pidFile: join(LOG_CAPTURE_DIR, `${udid}.pid`),
  };
}

export function stopLogCapture(udid: Udid): boolean {
  const { pidFile } = logCapturePaths(udid);
  if (!existsSync(pidFile)) return false;
  let stopped = false;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (pid > 0) {
      try { process.kill(-pid, "SIGTERM"); stopped = true; }
      catch { try { process.kill(pid, "SIGTERM"); stopped = true; } catch {} }
    }
  } catch {}
  try { rmSync(pidFile); } catch {}
  return stopped;
}

export function startLogCapture(udid: Udid, opts: { verbose?: boolean; predicate?: string } = {}): { pid: number; file: string } {
  const { dir, file, pidFile } = logCapturePaths(udid);
  mkdirSync(dir, { recursive: true });
  stopLogCapture(udid);
  const fd = openSync(file, "w");
  const args = ["simctl", "spawn", udid, "log", "stream", "--style", "ndjson", "--level", opts.verbose ? "debug" : "info"];
  if (opts.predicate) args.push("--predicate", opts.predicate);
  const child = spawn("xcrun", args, { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  try { closeSync(fd); } catch {}
  const pid = child.pid ?? 0;
  writeFileSync(pidFile, String(pid));
  return { pid, file };
}

export interface Capture {
  udid: string;
  file: string;
  size: number;
  modified: string;
  capturing: boolean;
  pid?: number;
}

export function listCaptures(): Capture[] {
  if (!existsSync(LOG_CAPTURE_DIR)) return [];
  const out: Capture[] = [];
  for (const name of readdirSync(LOG_CAPTURE_DIR)) {
    if (!name.endsWith(".log")) continue;
    const udid = name.slice(0, -4);
    const { file, pidFile } = logCapturePaths(udid);
    let size = 0, modified = "";
    try { const st = statSync(file); size = st.size; modified = st.mtime.toISOString(); } catch {}
    let pid: number | undefined;
    let capturing = false;
    if (existsSync(pidFile)) {
      const p = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (p > 0) { pid = p; try { process.kill(p, 0); capturing = true; } catch {} }
    }
    out.push({ udid, file, size, modified, capturing, ...(pid ? { pid } : {}) });
  }
  return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

export function findDerivedApp(bundleId: string): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const root = `${home}/Library/Developer/Xcode/DerivedData`;
  const r = spawnSync(
    "bash",
    [
      "-c",
      `find "${root}" -type d -path "*/Build/Products/Debug-iphonesimulator/*.app" -prune 2>/dev/null | while read -r p; do printf '%s\\t%s\\n' "$(stat -f %m "$p")" "$p"; done | sort -rn | cut -f2-`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return undefined;
  const candidates = r.stdout.split("\n").filter(Boolean);
  for (const app of candidates) {
    const plist = `${app}/Info.plist`;
    const idr = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8" });
    if (idr.status === 0 && idr.stdout.trim() === bundleId) return app;
  }
  return undefined;
}

export function detectXcodeProject(cwd: string = process.cwd()): { workspace?: string; project?: string } {
  const r = spawnSync("bash", ["-c", `ls -1d "${cwd}"/*.xcworkspace "${cwd}"/*.xcodeproj 2>/dev/null`], { encoding: "utf8" });
  const entries = (r.stdout ?? "").split("\n").filter(Boolean);
  const ws = entries.find((e) => e.endsWith(".xcworkspace"));
  if (ws) return { workspace: ws };
  const proj = entries.find((e) => e.endsWith(".xcodeproj"));
  if (proj) return { project: proj };
  return {};
}

export function detectScheme(opts: { workspace?: string; project?: string }): string | undefined {
  const args = ["-list", "-json"];
  if (opts.workspace) args.push("-workspace", opts.workspace);
  else if (opts.project) args.push("-project", opts.project);
  const r = spawnSync("xcodebuild", args, { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout);
    const schemes: string[] = j.workspace?.schemes ?? j.project?.schemes ?? [];
    return schemes.length === 1 ? schemes[0] : undefined;
  } catch { return undefined; }
}

function hasXcpretty(): boolean {
  return spawnSync("bash", ["-c", "command -v xcpretty"], { encoding: "utf8" }).status === 0;
}

export async function build(opts: {
  workspace?: string;
  project?: string;
  scheme: string;
  configuration?: string;
}): Promise<void> {
  const args: string[] = [];
  if (opts.workspace) args.push("-workspace", opts.workspace);
  else if (opts.project) args.push("-project", opts.project);
  args.push("-scheme", opts.scheme, "-configuration", opts.configuration ?? "Debug",
    "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "build");

  const child = hasXcpretty()
    ? spawn("bash", ["-c", `set -o pipefail; xcodebuild ${args.map(shellQuote).join(" ")} | xcpretty`], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn("xcodebuild", args, { stdio: ["ignore", "pipe", "pipe"] });

  const chunks: Buffer[] = [];
  child.stdout!.on("data", (c) => chunks.push(c));
  child.stderr!.on("data", (c) => chunks.push(c));

  const code: number = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
  if (code !== 0) {
    process.stderr.write(Buffer.concat(chunks));
    throw new Error(`xcodebuild failed (exit ${code})`);
  }
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export type ContainerKind = "app" | "data";

function containerPath(udid: Udid, bundleId: string, rel: string, kind: ContainerKind): string {
  return join(getAppContainer(udid, bundleId, kind), rel);
}

export function fileLs(udid: Udid, bundleId: string, rel: string, kind: ContainerKind) {
  const full = containerPath(udid, bundleId, rel, kind);
  if (!existsSync(full)) throw new Error(`not found in ${kind} container: ${rel}`);
  const st = statSync(full);
  if (!st.isDirectory()) {
    return [{ name: basename(full), isDir: false, size: st.size, modified: st.mtime.toISOString() }];
  }
  return readdirSync(full).map((name) => {
    const s = statSync(join(full, name));
    return { name, isDir: s.isDirectory(), size: s.size, modified: s.mtime.toISOString() };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function filePull(udid: Udid, bundleId: string, rel: string, dest: string, kind: ContainerKind): string[] {
  const src = containerPath(udid, bundleId, rel, kind);
  if (!existsSync(src)) throw new Error(`not found in ${kind} container: ${rel}`);
  mkdirSync(dest, { recursive: true });
  const files: string[] = [];
  if (statSync(src).isDirectory()) {
    for (const name of readdirSync(src)) {
      cpSync(join(src, name), join(dest, name), { recursive: true });
      files.push(name);
    }
  } else {
    const name = basename(src);
    cpSync(src, join(dest, name));
    files.push(name);
  }
  return files;
}

export function filePush(udid: Udid, bundleId: string, src: string, rel: string, kind: ContainerKind): void {
  if (!existsSync(src)) throw new Error(`local source not found: ${src}`);
  const dest = containerPath(udid, bundleId, rel, kind);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

export function fileRm(udid: Udid, bundleId: string, rel: string, kind: ContainerKind): void {
  const full = containerPath(udid, bundleId, rel, kind);
  if (!existsSync(full)) throw new Error(`not found in ${kind} container: ${rel}`);
  rmSync(full, { recursive: true, force: true });
}

export function fileMkdir(udid: Udid, bundleId: string, rel: string, kind: ContainerKind): void {
  mkdirSync(containerPath(udid, bundleId, rel, kind), { recursive: true });
}

export function fileMv(udid: Udid, bundleId: string, src: string, dst: string, kind: ContainerKind): void {
  const s = containerPath(udid, bundleId, src, kind);
  const d = containerPath(udid, bundleId, dst, kind);
  if (!existsSync(s)) throw new Error(`not found in ${kind} container: ${src}`);
  mkdirSync(dirname(d), { recursive: true });
  renameSync(s, d);
}

export function privacy(udid: Udid, action: "grant" | "revoke" | "reset", service: string, bundleId?: string): void {
  const args = ["privacy", udid, action, service];
  if (bundleId) args.push(bundleId);
  ok(args);
}

export function setAppearance(udid: Udid, mode: "light" | "dark"): void {
  ok(["ui", udid, "appearance", mode]);
}

export function clearKeychain(udid: Udid): void {
  ok(["keychain", udid, "reset"]);
}

export function keychainAddCert(udid: Udid, action: "add-root-cert" | "add-cert", path: string): void {
  ok(["keychain", udid, action, path]);
}

export function pushNotification(udid: Udid, bundleId: string | undefined, payloadPath: string): void {
  const args = ["push", udid];
  if (bundleId) args.push(bundleId);
  args.push(payloadPath);
  ok(args);
}

export function statusBarOverride(udid: Udid, opts: Record<string, string>): void {
  const args = ["status_bar", udid, "override"];
  for (const [k, v] of Object.entries(opts)) args.push(`--${k}`, v);
  ok(args);
}

export function statusBarClear(udid: Udid): void {
  ok(["status_bar", udid, "clear"]);
}

const VIDEO_DIR = join(homedir(), ".sim-cli", "videos");

function videoPidFile(udid: Udid): string {
  return join(VIDEO_DIR, `${udid}.json`);
}

export function startRecordVideo(udid: Udid, outPath: string): { pid: number; file: string } {
  mkdirSync(VIDEO_DIR, { recursive: true });
  stopRecordVideo(udid);
  const child = spawn("xcrun", ["simctl", "io", udid, "recordVideo", "--force", outPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid ?? 0;
  writeFileSync(videoPidFile(udid), JSON.stringify({ pid, file: outPath }));
  return { pid, file: outPath };
}

export function stopRecordVideo(udid: Udid): { stopped: boolean; pid?: number; file?: string } {
  const pidFile = videoPidFile(udid);
  if (!existsSync(pidFile)) return { stopped: false };
  let info: { pid: number; file: string };
  try { info = JSON.parse(readFileSync(pidFile, "utf8")); }
  catch { try { rmSync(pidFile); } catch {} return { stopped: false }; }
  let stopped = false;
  try { process.kill(info.pid, "SIGINT"); stopped = true; } catch {}
  try { rmSync(pidFile); } catch {}
  return { stopped, pid: info.pid, file: info.file };
}

const CRASH_DIR = join(homedir(), "Library", "Logs", "DiagnosticReports");

export interface CrashReport {
  name: string;
  path: string;
  size: number;
  modified: string;
  bundle?: string;
  app?: string;
  pid?: number;
  os?: string;
}

function parseCrashHead(path: string): Partial<CrashReport> {
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
    const meta = JSON.parse(first);
    return {
      bundle: meta.bundleID,
      app: meta.app_name ?? meta.name,
      pid: meta.pid,
      os: meta.os_version,
    };
  } catch { return {}; }
}

export function listCrashes(opts: { bundle?: string } = {}): CrashReport[] {
  if (!existsSync(CRASH_DIR)) return [];
  const out: CrashReport[] = [];
  for (const name of readdirSync(CRASH_DIR)) {
    if (!name.endsWith(".ips") && !name.endsWith(".crash")) continue;
    const path = join(CRASH_DIR, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    const meta = parseCrashHead(path);
    if (opts.bundle && meta.bundle !== opts.bundle) continue;
    out.push({ name, path, size: st.size, modified: st.mtime.toISOString(), ...meta });
  }
  return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

export function showCrash(name: string): string {
  const path = join(CRASH_DIR, name);
  if (!existsSync(path)) throw new Error(`crash not found: ${name}`);
  return readFileSync(path, "utf8");
}

export function deleteCrash(name: string): void {
  const path = join(CRASH_DIR, name);
  if (!existsSync(path)) throw new Error(`crash not found: ${name}`);
  rmSync(path);
}
