import { spawn, spawnSync } from "node:child_process";

export type Udid = string | "booted";

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function ok(args: string[]): string {
  const r = run(args);
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

export function launch(udid: Udid, bundleId: string, args: string[]): { pid: number } {
  const out = ok(["launch", udid, bundleId, ...args]);
  // "com.example.app: 12345"
  const m = out.match(/:\s*(\d+)/);
  return { pid: m ? parseInt(m[1]!, 10) : 0 };
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

/** One-shot recent logs. */
export function logShow(udid: Udid, opts: { last?: string; predicate?: string }): string {
  const args = ["simctl", "spawn", udid, "log", "show", "--style", "compact"];
  if (opts.last) args.push("--last", opts.last);
  if (opts.predicate) args.push("--predicate", opts.predicate);
  const r = spawnSync("xcrun", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "log show failed");
  return r.stdout;
}
