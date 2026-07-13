import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { STATE_DIR } from "./resolve.ts";
import * as simctl from "./simctl.ts";

const CACHE_PATH = join(STATE_DIR, "builds.json");

export type BuildEntry = { app: string; fingerprint: string; builtAt: string };

export function readCache(): Record<string, BuildEntry> {
  try { return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, BuildEntry>; }
  catch { return {}; }
}

function saveCache(cache: Record<string, BuildEntry>) {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function git(dir: string, args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

function fileStamp(path: string): (number | string)[] {
  try {
    const st = statSync(path);
    return [st.size, st.mtimeMs];
  } catch {
    return ["gone"];
  }
}

export function treeFingerprint(dir: string): string | undefined {
  const head = git(dir, ["rev-parse", "HEAD"])?.trim();
  const top = git(dir, ["rev-parse", "--show-toplevel"])?.trim();
  const status = git(dir, ["status", "--porcelain", "-z", "-uall"]);
  if (!head || !top || status === undefined) return undefined;
  const entries: unknown[] = [];
  const tokens = status.split("\0").filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    entries.push([xy, path, ...fileStamp(join(top, path))]);
    if (xy[0] === "R" || xy[0] === "C") entries.push(["<-", tokens[++i]]);
  }
  return createHash("sha256").update(JSON.stringify([head, entries])).digest("hex");
}

function cacheKey(opts: simctl.BuildOpts): string {
  return [
    resolvePath(opts.workspace ?? opts.project!),
    opts.scheme,
    opts.configuration ?? "Debug",
    opts.derivedData ? resolvePath(opts.derivedData) : "",
  ].join("\n");
}

export type EnsureResult = { app?: string; skipped: boolean };

export async function ensureBuilt(opts: simctl.BuildOpts, force = false): Promise<EnsureResult> {
  const key = cacheKey(opts);
  const dir = dirname(resolvePath(opts.workspace ?? opts.project!));
  const fingerprint = treeFingerprint(dir);
  const entry = readCache()[key];
  if (!force && fingerprint && entry?.fingerprint === fingerprint && existsSync(entry.app)) {
    return { app: entry.app, skipped: true };
  }
  const pendingApp = simctl.resolveBuiltAppAsync(opts);
  await simctl.build(opts);
  const app = (await pendingApp) ?? simctl.resolveBuiltApp(opts);
  if (app && fingerprint) {
    const cache = readCache();
    cache[key] = { app, fingerprint, builtAt: new Date().toISOString() };
    saveCache(cache);
  }
  return { app, skipped: false };
}
