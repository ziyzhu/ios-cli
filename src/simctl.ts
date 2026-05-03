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

/** Stream logs to stdout until SIGINT. */
export function logStream(udid: Udid, predicate?: string): Promise<number> {
  const args = ["simctl", "spawn", udid, "log", "stream", "--style", "compact"];
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

/** Run xcodebuild for the iphonesimulator SDK; throws with stderr on failure.
 *  Pipes through xcpretty when available for cleaner output. */
export function build(opts: {
  workspace?: string;
  project?: string;
  scheme: string;
  configuration?: string;
}): void {
  const args: string[] = [];
  if (opts.workspace) args.push("-workspace", opts.workspace);
  else if (opts.project) args.push("-project", opts.project);
  args.push("-scheme", opts.scheme, "-configuration", opts.configuration ?? "Debug",
    "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "build");
  const tail = (s: string) => s.split("\n").slice(-80).join("\n");

  if (hasXcpretty()) {
    // pipefail preserves xcodebuild's exit code through the pipe; xcpretty re-emits errors at the end.
    const cmd = ["set -o pipefail", `xcodebuild ${args.map(shellQuote).join(" ")} | xcpretty`].join("; ");
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`xcodebuild failed:\n${tail(r.stdout)}\n${tail(r.stderr)}`.trim());
    return;
  }

  const r = spawnSync("xcodebuild", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) {
    // xcodebuild puts compile errors in stdout; include both streams so failures are diagnosable.
    throw new Error(`xcodebuild failed:\n${tail(r.stdout)}\n${tail(r.stderr)}`.trim());
  }
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One-shot recent logs. */
export function logShow(udid: Udid, opts: { last?: string; predicate?: string }): string {
  const args = ["simctl", "spawn", udid, "log", "show", "--style", "compact"];
  if (opts.last) args.push("--last", opts.last);
  if (opts.predicate) args.push("--predicate", opts.predicate);
  const r = spawnSync("xcrun", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "log show failed");
  return r.stdout;
}
