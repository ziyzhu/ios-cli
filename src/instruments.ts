import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TRACE_TEMPLATES = {
  "time-profiler": "Time Profiler",
} as const;

export type TraceTemplate = keyof typeof TRACE_TEMPLATES;

export interface TraceInfo {
  pid: number;
  appPid: number;
  process: string;
  bundle: string;
  device: string;
  template: TraceTemplate;
  instrumentTemplate: string;
  file: string;
  log: string;
  startedAt: string;
}

const TRACE_DIR = join(homedir(), ".sim-cli", "traces");

function statePath(udid: string): string {
  return join(TRACE_DIR, `${udid}.json`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(udid: string): TraceInfo | undefined {
  const path = statePath(udid);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    try { rmSync(path); } catch {}
    return undefined;
  }
}

function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function logTail(path: string): string {
  try {
    return readFileSync(path, "utf8").trim().split("\n").slice(-8).join("\n");
  } catch {
    return "";
  }
}

function recordingFailure(path: string): string | undefined {
  const tail = logTail(path);
  return tail.includes("Recording failed with errors") ? tail : undefined;
}

export function traceArgs(info: {
  udid: string;
  process: string;
  template: TraceTemplate;
  file: string;
  notification: string;
}): string[] {
  return [
    "xctrace", "record",
    "--template", TRACE_TEMPLATES[info.template],
    "--device", info.udid,
    "--attach", info.process,
    "--output", info.file,
    "--notify-tracing-started", info.notification,
  ];
}

export function exportTrace(options: { input: string; out?: string; xpath?: string }): { input: string; file: string; mode: "toc" | "xpath"; xpath?: string } {
  const input = resolve(options.input);
  if (!existsSync(input)) throw new Error(`trace not found: ${input}`);
  const file = resolve(options.out ?? join(tmpdir(), `sim-cli-trace-export-${Date.now()}.xml`));
  if (existsSync(file)) throw new Error(`trace export already exists: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  const query = options.xpath ? ["--xpath", options.xpath] : ["--toc"];
  const result = spawnSync("xcrun", ["xctrace", "export", "--input", input, ...query, "--output", file], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Instruments trace export failed");
  }
  return { input, file, mode: options.xpath ? "xpath" : "toc", ...(options.xpath ? { xpath: options.xpath } : {}) };
}

export async function startTrace(options: {
  udid: string;
  appPid: number;
  process: string;
  bundle: string;
  template: TraceTemplate;
  out?: string;
  readyTimeoutMs?: number;
}): Promise<TraceInfo> {
  mkdirSync(TRACE_DIR, { recursive: true });
  const prior = readState(options.udid);
  if (prior && alive(prior.pid)) {
    throw new Error(`trace ${prior.pid} is already recording on ${options.udid}; run \`sim --device ${options.udid} trace stop\``);
  }
  if (prior) try { rmSync(statePath(options.udid)); } catch {}

  const stamp = Date.now();
  const file = resolve(options.out ?? join(tmpdir(), `sim-cli-${options.template}-${stamp}.trace`));
  if (existsSync(file)) throw new Error(`trace output already exists: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  const log = join(TRACE_DIR, `${options.udid}-${stamp}.log`);
  const notification = `ai.sim-cli.trace.${process.pid}.${stamp}`;
  const notifier = spawn("notifyutil", ["-1", notification], { stdio: "ignore" });
  await delay(50);

  const logFd = openSync(log, "w");
  const child = spawn("xcrun", traceArgs({
    udid: options.udid,
    process: options.process,
    template: options.template,
    file,
    notification,
  }), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);

  const outcome = await Promise.race([
    exitOf(notifier).then((code) => ({ kind: "ready" as const, code })),
    exitOf(child).then((code) => ({ kind: "trace-exit" as const, code })),
    delay(options.readyTimeoutMs ?? 30_000).then(() => ({ kind: "timeout" as const, code: null })),
  ]);

  if (outcome.kind !== "ready" || outcome.code !== 0 || child.pid === undefined) {
    try { notifier.kill("SIGTERM"); } catch {}
    try { child.kill("SIGINT"); } catch {}
    const detail = logTail(log);
    if (outcome.kind === "timeout") throw new Error(`Instruments did not start recording within ${options.readyTimeoutMs ?? 30_000}ms${detail ? `: ${detail}` : ""}`);
    throw new Error(`Instruments failed to start${detail ? `: ${detail}` : ` (exit ${outcome.code ?? "unknown"})`}`);
  }

  await delay(500);
  const immediateFailure = recordingFailure(log);
  if (!alive(child.pid) || immediateFailure) {
    try { notifier.kill("SIGTERM"); } catch {}
    throw new Error(`Instruments recording stopped during startup${immediateFailure ? `: ${immediateFailure}` : ""}`);
  }

  child.unref();
  const info: TraceInfo = {
    pid: child.pid,
    appPid: options.appPid,
    process: options.process,
    bundle: options.bundle,
    device: options.udid,
    template: options.template,
    instrumentTemplate: TRACE_TEMPLATES[options.template],
    file,
    log,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(statePath(options.udid), JSON.stringify(info));
  return info;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(50);
  }
  return !alive(pid);
}

export async function stopTrace(udid: string, timeoutMs = 60_000): Promise<TraceInfo & { stopped: boolean; completed: boolean }> {
  const info = readState(udid);
  if (!info) throw new Error(`no active trace for ${udid}`);
  const wasAlive = alive(info.pid);
  if (wasAlive) {
    try { process.kill(info.pid, "SIGINT"); }
    catch (error) { throw new Error(`could not stop trace ${info.pid}: ${(error as Error).message}`); }
    if (!await waitForExit(info.pid, timeoutMs)) {
      throw new Error(`trace ${info.pid} did not finalize within ${timeoutMs}ms; state preserved at ${statePath(udid)}`);
    }
  }
  try { rmSync(statePath(udid)); } catch {}
  const completed = existsSync(info.file);
  const failure = recordingFailure(info.log);
  if (failure) throw new Error(`Instruments recording failed: ${failure}`);
  if (!completed) {
    const detail = logTail(info.log);
    throw new Error(`trace ${info.pid} exited without creating ${info.file}${detail ? `: ${detail}` : ""}`);
  }
  return { ...info, stopped: wasAlive, completed };
}
