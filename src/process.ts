import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

const libproc = dlopen("/usr/lib/libproc.dylib", {
  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});
const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
});

const RUSAGE_INFO_V4 = 4;
const RUSAGE_V4_WORDS = 38;
const RI_USER_TIME = 2;
const RI_SYSTEM_TIME = 3;
const RI_PHYS_FOOTPRINT = 9;
const RI_DISKIO_BYTESREAD = 18;
const RI_DISKIO_BYTESWRITTEN = 19;
const RI_LIFETIME_MAX_PHYS_FOOTPRINT = 30;

let machNsPerTick: number | undefined;
function ticksToNs(ticks: bigint): number {
  if (machNsPerTick === undefined) {
    const tb = new Uint32Array(2);
    libSystem.symbols.mach_timebase_info(ptr(tb));
    machNsPerTick = tb[0]! / tb[1]!;
  }
  return Number(ticks) * machNsPerTick;
}

export function resolvePid(udid: string, bundleId: string): number {
  const r = spawnSync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "launchctl list failed");
  const needle = `UIKitApplication:${bundleId}[`;
  for (const line of r.stdout.split("\n")) {
    if (!line.includes(needle)) continue;
    const pid = parseInt(line, 10);
    if (pid > 0) return pid;
  }
  throw new Error(`${bundleId} is not running on ${udid}`);
}

export interface Rusage {
  cpuNs: number;
  footprintBytes: number;
  footprintPeakBytes: number;
  diskReadBytes: number;
  diskWrittenBytes: number;
}

export function rusage(pid: number): Rusage {
  const buf = new BigUint64Array(RUSAGE_V4_WORDS);
  const rc = libproc.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buf));
  if (rc !== 0) throw new Error(`process ${pid} is not readable (exited?)`);
  return {
    cpuNs: ticksToNs(buf[RI_USER_TIME]! + buf[RI_SYSTEM_TIME]!),
    footprintBytes: Number(buf[RI_PHYS_FOOTPRINT]!),
    footprintPeakBytes: Number(buf[RI_LIFETIME_MAX_PHYS_FOOTPRINT]!),
    diskReadBytes: Number(buf[RI_DISKIO_BYTESREAD]!),
    diskWrittenBytes: Number(buf[RI_DISKIO_BYTESWRITTEN]!),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function mb(bytes: number): number {
  return round1(bytes / 1048576);
}

export interface Gauges {
  cpuPct: number;
  footprintMb: number;
  footprintPeakMb: number;
  diskReadMb: number;
  diskWrittenMb: number;
}

export function gaugesDelta(a: Rusage, b: Rusage, wallMs: number): Gauges {
  return {
    cpuPct: round1(((b.cpuNs - a.cpuNs) / (wallMs * 1e6)) * 100),
    footprintMb: mb(b.footprintBytes),
    footprintPeakMb: mb(b.footprintPeakBytes),
    diskReadMb: mb(b.diskReadBytes),
    diskWrittenMb: mb(b.diskWrittenBytes),
  };
}

export async function gauges(pid: number, windowMs: number): Promise<Gauges> {
  const a = rusage(pid);
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, windowMs));
  const b = rusage(pid);
  return gaugesDelta(a, b, performance.now() - t0);
}

export function netTotals(pid: number): { rxBytes: number; txBytes: number } | undefined {
  const r = spawnSync("nettop", ["-p", String(pid), "-x", "-L", "1"], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const lines = r.stdout.trim().split("\n");
  const header = lines[0]?.split(",") ?? [];
  const iIn = header.indexOf("bytes_in");
  const iOut = header.indexOf("bytes_out");
  if (iIn < 0 || iOut < 0) return undefined;
  let rx = 0, tx = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (!cells[1]?.endsWith(`.${pid}`)) continue;
    rx += Number(cells[iIn]) || 0;
    tx += Number(cells[iOut]) || 0;
  }
  return { rxBytes: rx, txBytes: tx };
}

export function duMb(path: string): number {
  const r = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "du failed");
  return round1(parseInt(r.stdout, 10) / 1024);
}

const SIZE_RE = /([\d.]+)\s*(B|KB|MB|GB)/;
function sizeToKb(s: string): number {
  const m = s.match(SIZE_RE);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  const scale = { B: 1 / 1024, KB: 1, MB: 1024, GB: 1048576 }[m[2] as "B" | "KB" | "MB" | "GB"];
  return round1(n * scale);
}

export interface FootprintCategory {
  category: string;
  dirtyKb: number;
  cleanKb: number;
  reclaimableKb: number;
  regions: number;
}

export function footprint(pid: number): { footprintMb: number; categories: FootprintCategory[] } {
  const r = spawnSync("footprint", [String(pid)], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `footprint ${pid} failed`);
  const total = r.stdout.match(/Footprint:\s*([\d.]+\s*[KMG]?B)/);
  const categories: FootprintCategory[] = [];
  const row = /^\s*([\d.]+\s*[KMG]?B)\s+([\d.]+\s*[KMG]?B)\s+([\d.]+\s*[KMG]?B)\s+(\d+)\s+(\S.*?)\s*$/;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(row);
    if (!m) continue;
    categories.push({
      category: m[5]!,
      dirtyKb: sizeToKb(m[1]!),
      cleanKb: sizeToKb(m[2]!),
      reclaimableKb: sizeToKb(m[3]!),
      regions: parseInt(m[4]!, 10),
    });
  }
  return { footprintMb: total ? round1(sizeToKb(total[1]!) / 1024) : 0, categories };
}

export function leaksScan(pid: number): { report: string; leakCount: number; leakedBytes: number } {
  const r = spawnSync("leaks", [String(pid)], { encoding: "utf8", timeout: 120000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/Process \d+: (\d+) leaks? for (\d+) total leaked bytes/);
  if (!m) throw new Error(out.trim().split("\n").slice(-3).join("\n") || "leaks failed");
  return { report: out, leakCount: parseInt(m[1]!, 10), leakedBytes: parseInt(m[2]!, 10) };
}

export interface StackEntry {
  symbol: string;
  library?: string;
  count: number;
}

export function samplePid(pid: number, durationS: number, outFile: string): StackEntry[] {
  const r = spawnSync("sample", [String(pid), String(durationS), "-file", outFile], {
    encoding: "utf8",
    timeout: (durationS + 60) * 1000,
  });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "sample failed");
  const text = readFileSync(outFile, "utf8");
  const start = text.indexOf("Sort by top of stack");
  if (start < 0) return [];
  const top: StackEntry[] = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    const m = line.match(/^\s+(.+?)\s+\(in (.+?)\)\s+(\d+)\s*$/);
    const bare = m ? undefined : line.match(/^\s+(\S.*?)\s{2,}(\d+)\s*$/);
    if (m) top.push({ symbol: m[1]!, library: m[2]!, count: parseInt(m[3]!, 10) });
    else if (bare) top.push({ symbol: bare[1]!, count: parseInt(bare[2]!, 10) });
    else break;
    if (top.length >= 15) break;
  }
  return top;
}

const VIEW_HIERARCHY_EXPR =
  "(NSString *)[[[UIApplication sharedApplication] keyWindow] recursiveDescription]" +
  " ?: (NSString *)[[[[UIApplication sharedApplication] windows] firstObject] recursiveDescription]";
const VC_HIERARCHY_EXPR =
  "(NSString *)[[[[UIApplication sharedApplication] keyWindow] rootViewController] _printHierarchy]";

export function lldbExpr(pid: number, objcExpr: string, timeoutMs = 120000): string {
  const cmd = `expr -l objc -O -- ${objcExpr}`;
  const r = spawnSync("lldb", ["--batch", "-p", String(pid), "-o", cmd], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (r.signal) {
    try { process.kill(pid, "SIGCONT"); } catch {}
    throw new Error(`lldb timed out after ${timeoutMs}ms attached to ${pid}; sent SIGCONT`);
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const attachError = out.match(/error: attach failed:?\s*(.*)/i);
  if (attachError) {
    throw new Error(
      `lldb could not attach to pid ${pid}: ${attachError[1] || "unknown"} ` +
      "(another debugger attached, or not a debuggable build?)",
    );
  }
  const echo = out.indexOf("(lldb) expr -l objc -O --");
  if (echo < 0) throw new Error(out.trim().slice(-400) || "lldb produced no output");
  const result = out.slice(out.indexOf("\n", echo) + 1).trimEnd();
  const errorLine = result.split("\n").find((l) => l.startsWith("error: "));
  if (errorLine) throw new Error(`lldb expression failed: ${errorLine}`);
  return result;
}

export function viewHierarchy(pid: number): string {
  return lldbExpr(pid, VIEW_HIERARCHY_EXPR);
}

export function vcHierarchy(pid: number): string {
  return lldbExpr(pid, VC_HIERARCHY_EXPR);
}
