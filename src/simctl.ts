import { spawn, spawnSync } from "node:child_process";

export type Udid = string | "booted";

function run(args: string[], env?: NodeJS.ProcessEnv): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8", env });
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

export function listApps(udid: Udid): unknown {
  // simctl listapps returns plist; parse via plutil to JSON
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

/** Read MinimumOSVersion from an .app's Info.plist (e.g. "26.2"). Returns
 *  undefined if the bundle, plist, or key is missing — caller decides whether
 *  to warn or skip the preflight. */
export function appMinimumOSVersion(appPath: string): string | undefined {
  const plist = `${appPath}/Info.plist`;
  const r = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :MinimumOSVersion", plist], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const v = r.stdout.trim();
  return v || undefined;
}

/** Look up a sim's runtime version + name by UDID. "26.0.1" / "mango-qa". */
export function deviceRuntime(udid: string): { name?: string; osVersion?: string } | undefined {
  let devices: any;
  try { devices = listDevices() as any; } catch { return undefined; }
  for (const [runtimeId, list] of Object.entries(devices?.devices ?? {}) as [string, any[]][]) {
    for (const d of list) {
      if (d?.udid === udid) {
        // runtimeId looks like "com.apple.CoreSimulator.SimRuntime.iOS-26-0-1";
        // pull out the version segment.
        const m = runtimeId.match(/iOS-(\d+(?:-\d+)*)/);
        const osVersion = m ? m[1]!.replaceAll("-", ".") : undefined;
        return { name: d.name, osVersion };
      }
    }
  }
  return undefined;
}

/** Returns -1, 0, or 1 comparing dotted version strings ("26.0.1" vs "26.2"). */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Throws a one-line, actionable error if the app's deployment target exceeds
 *  the sim's runtime. simctl install otherwise emits a wall of
 *  IXUserPresentableErrorDomain text that buries the version mismatch. */
export function preflightInstallCompat(udid: string, appPath: string): void {
  const need = appMinimumOSVersion(appPath);
  if (!need) return;
  const dev = deviceRuntime(udid);
  if (!dev?.osVersion) return;
  if (cmpVersion(dev.osVersion, need) >= 0) return;
  const who = dev.name ? `${dev.name} (${udid})` : udid;
  throw new Error(`incompatible: ${appPath.split("/").pop()} requires iOS ${need}, ${who} runs iOS ${dev.osVersion}; pick a sim on iOS ${need} or higher`);
}

export function uninstall(udid: Udid, bundleId: string): void {
  ok(["uninstall", udid, bundleId]);
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
  // "com.example.app: 12345"
  const m = out.match(/:\s*(\d+)/);
  return { pid: m ? parseInt(m[1]!, 10) : 0 };
}

/** Poll until the app is registered in the simulator's launchd, or timeout. */
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

/** Stream ndjson log entries to stdout until SIGINT (one JSON object per line). */
export function logStream(udid: Udid, predicate?: string, opts: { verbose?: boolean } = {}): Promise<number> {
  const args = ["simctl", "spawn", udid, "log", "stream", "--style", "ndjson"];
  // `log stream` defaults to notice+ which silently drops `os_log_info`
  // (most app-side debugging logs). Lift to info+ so they appear without -v;
  // -v further opens the gate to debug.
  args.push("--level", opts.verbose ? "debug" : "info");
  if (predicate) args.push("--predicate", predicate);
  const child = spawn("xcrun", args, { stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}

/**
 * Locate the most recently built `.app` for `bundleId` in Xcode DerivedData.
 * Returns absolute path, or undefined if none matches.
 */
export function findDerivedApp(bundleId: string): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const root = `${home}/Library/Developer/Xcode/DerivedData`;
  const r = spawnSync(
    "bash",
    [
      "-c",
      // Find every Debug-iphonesimulator .app bundle, newest first.
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

/** Auto-detect an .xcworkspace or .xcodeproj in the current directory. */
export function detectXcodeProject(cwd: string = process.cwd()): { workspace?: string; project?: string } {
  const r = spawnSync("bash", ["-c", `ls -1d "${cwd}"/*.xcworkspace "${cwd}"/*.xcodeproj 2>/dev/null`], { encoding: "utf8" });
  const entries = (r.stdout ?? "").split("\n").filter(Boolean);
  const ws = entries.find((e) => e.endsWith(".xcworkspace"));
  if (ws) return { workspace: ws };
  const proj = entries.find((e) => e.endsWith(".xcodeproj"));
  if (proj) return { project: proj };
  return {};
}

/** Use `xcodebuild -list -json` to find the only scheme; returns undefined if multiple. */
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

/** Run xcodebuild for the iphonesimulator SDK, streaming output to stderr in
 *  real time so the JSON result on stdout stays clean. Pipes through xcpretty
 *  when available. Throws on non-zero exit. */
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

  // Capture build output silently; only surface it (on stderr) if the build fails.
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

const XCTEST_DEVICES_DIR = `${process.env.HOME ?? ""}/Library/Developer/XCTestDevices`;

export interface TestOptions {
  workspace?: string;
  project?: string;
  scheme: string;
  destinationUdid: string;       // pinned sim UDID (or "booted")
  configuration?: string;
  only?: string[];               // -only-testing:<id>, repeatable
  skip?: string[];               // -skip-testing:<id>, repeatable
  resultBundlePath?: string;     // .xcresult output
  timeoutSec?: number;           // hard kill xcodebuild after this many seconds
  buildOnly?: boolean;           // build-for-testing
  noBuild?: boolean;             // test-without-building (assumes prior build)
}

export interface TestResult {
  passed: number;
  failed: number;
  failures: Array<{ test: string; message: string }>;
  resultBundlePath?: string;
  timedOut: boolean;
  exitCode: number;
}

/** xcodebuild test wrapper. Streams stderr live, parses the .xcresult on
 *  exit via `xcresulttool`, returns structured pass/fail summary. Hard-kills
 *  the runner on `timeoutSec` so a hung test doesn't block forever. */
export async function test(opts: TestOptions): Promise<TestResult> {
  const args: string[] = [];
  if (opts.workspace) args.push("-workspace", opts.workspace);
  else if (opts.project) args.push("-project", opts.project);
  args.push("-scheme", opts.scheme);
  if (opts.configuration) args.push("-configuration", opts.configuration);
  args.push("-destination", `platform=iOS Simulator,id=${opts.destinationUdid}`);
  for (const o of opts.only ?? []) args.push(`-only-testing:${o}`);
  for (const s of opts.skip ?? []) args.push(`-skip-testing:${s}`);

  const resultBundle = opts.resultBundlePath
    ?? `${process.env.TMPDIR ?? "/tmp"}sim-cli-test-${Date.now()}.xcresult`;
  args.push("-resultBundlePath", resultBundle);

  const sub = opts.buildOnly ? "build-for-testing" : opts.noBuild ? "test-without-building" : "test";
  args.push(sub);

  const child = spawn("xcodebuild", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (c) => process.stderr.write(c));
  child.stderr!.on("data", (c) => process.stderr.write(c));

  let timedOut = false;
  let killer: NodeJS.Timeout | undefined;
  if (opts.timeoutSec) {
    killer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, opts.timeoutSec * 1000);
  }

  const code: number = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
  if (killer) clearTimeout(killer);

  return { ...summarizeXcresult(resultBundle), resultBundlePath: resultBundle, timedOut, exitCode: code };
}

/** Parse pass/fail summary from `xcresulttool get test-results tests`. */
function summarizeXcresult(path: string): { passed: number; failed: number; failures: Array<{ test: string; message: string }> } {
  const r = spawnSync("xcrun", ["xcresulttool", "get", "test-results", "tests", "--path", path], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) {
    return { passed: 0, failed: 0, failures: [] };
  }
  let passed = 0, failed = 0;
  const failures: Array<{ test: string; message: string }> = [];
  try {
    const root = JSON.parse(r.stdout);
    const visit = (n: any, parent?: string) => {
      if (!n || typeof n !== "object") return;
      const name = n.name ?? parent;
      if (n.nodeType === "Test Case") {
        if (n.result === "Passed") passed++;
        else if (n.result === "Failed") {
          failed++;
          const msg = collectFailures(n).join("; ") || "(no message)";
          failures.push({ test: n.nodeIdentifier ?? name ?? "?", message: msg });
        }
      }
      for (const c of n.children ?? []) visit(c, name);
      for (const c of n.testNodes ?? []) visit(c, name);
    };
    visit(root);
  } catch { /* fall through with zeros */ }
  return { passed, failed, failures };
}
function collectFailures(node: any): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.nodeType === "Failure Message" && typeof n.name === "string") out.push(n.name);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

/** Locate the XCTestDevices clone created by xcodebuild test for the given
 *  parent UDID. xcodebuild clones the destination sim under
 *  `~/Library/Developer/XCTestDevices/<UUID>` and runs the host app inside
 *  it; the visible sim never sees the test process. Returns the clone UDID
 *  with the most recent mtime, or undefined if none exists yet. */
export function findTestCloneUdid(): string | undefined {
  const r = spawnSync("bash", ["-c",
    `ls -1dt "${XCTEST_DEVICES_DIR}"/* 2>/dev/null | head -1`,
  ], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const dir = r.stdout.trim();
  if (!dir) return undefined;
  return dir.split("/").pop();
}

/** Read logs from an XCTestDevices clone. The clone lives outside the default
 *  CoreSimulator devices set, so plain `xcrun simctl log show` can't find it;
 *  must point `--set` at `~/Library/Developer/XCTestDevices`. */
export function logShowFromClone(cloneUdid: string, opts: { last?: string; predicate?: string; verbose?: boolean }): unknown[] {
  const args = ["simctl", "--set", XCTEST_DEVICES_DIR, "spawn", cloneUdid, "log", "show", "--style", "ndjson"];
  args.push("--info");
  if (opts.verbose) args.push("--debug");
  if (opts.last) args.push("--last", opts.last);
  if (opts.predicate) args.push("--predicate", opts.predicate);
  const r = spawnSync("xcrun", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "log show failed");
  const entries: unknown[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line || line[0] !== "{") continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (!("eventMessage" in obj) && !("timestamp" in obj)) continue;
      entries.push(obj);
    } catch {}
  }
  return entries;
}

/** One-shot recent logs as parsed entries. `log show --style ndjson` emits one
 *  JSON object per line (after a header line), each with timestamp, subsystem,
 *  category, processImagePath, eventMessage, etc. */
export function logShow(udid: Udid, opts: { last?: string; predicate?: string; verbose?: boolean }): unknown[] {
  const args = ["simctl", "spawn", udid, "log", "show", "--style", "ndjson"];
  // Mirror logStream defaults: include info+ entries by default; -v adds debug.
  args.push("--info");
  if (opts.verbose) args.push("--debug");
  if (opts.last) args.push("--last", opts.last);
  if (opts.predicate) args.push("--predicate", opts.predicate);
  const r = spawnSync("xcrun", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "log show failed");
  const entries: unknown[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line || line[0] !== "{") continue; // skip header / blank lines
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // `log show --style ndjson` emits a summary line like {"finished":1,"count":N}
      // when the query ends; skip it so empty results return [] instead of [{count:0}].
      if (!("eventMessage" in obj) && !("timestamp" in obj)) continue;
      entries.push(obj);
    } catch { /* skip malformed */ }
  }
  return entries;
}
