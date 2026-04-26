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

/** One-shot recent logs. */
export function logShow(udid: Udid, opts: { last?: string; predicate?: string }): string {
  const args = ["simctl", "spawn", udid, "log", "show", "--style", "compact"];
  if (opts.last) args.push("--last", opts.last);
  if (opts.predicate) args.push("--predicate", opts.predicate);
  const r = spawnSync("xcrun", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "log show failed");
  return r.stdout;
}
