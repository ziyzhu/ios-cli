import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import * as companion from "./companion.ts";
import * as simctl from "./simctl.ts";

const REGISTRY_DIR = join(homedir(), ".sim-cli");
const REGISTRY_PATH = join(REGISTRY_DIR, "companions.json");

type RegistryEntry = { endpoint: string; pid?: number; spawnedAt: number };
type Registry = Record<string, RegistryEntry>;

export const STATE_DIR = REGISTRY_DIR;

function loadRegistry(): Registry {
  try { return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as Registry; }
  catch { return {}; }
}

export function readRegistry(): Record<string, RegistryEntry & { alive: boolean }> {
  const reg = loadRegistry();
  const out: Record<string, RegistryEntry & { alive: boolean }> = {};
  for (const [udid, e] of Object.entries(reg)) {
    out[udid] = { ...e, alive: e.pid ? pidAlive(e.pid) : false };
  }
  return out;
}

function saveRegistry(reg: Registry) {
  try { mkdirSync(REGISTRY_DIR, { recursive: true }); } catch {}
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function probe(endpoint: string): Promise<string | null> {
  const c = companion.makeClient(endpoint);
  try {
    const t = await companion.describeTarget(c, 800);
    return t.udid || null;
  } catch {
    return null;
  } finally {
    try { c.close?.(); } catch {}
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error("no port")));
      }
    });
  });
}

function findIdbCompanion(): string | null {
  const which = spawnSync("which", ["idb_companion"], { encoding: "utf8" });
  const found = which.stdout?.trim();
  if (found && existsSync(found)) return found;
  if (existsSync("/opt/homebrew/bin/idb_companion")) return "/opt/homebrew/bin/idb_companion";
  if (existsSync("/usr/local/bin/idb_companion")) return "/usr/local/bin/idb_companion";
  return null;
}

async function spawnCompanion(udid: string, port: number): Promise<number> {
  const bin = findIdbCompanion();
  if (!bin) throw new Error("idb_companion not found on PATH or in /opt/homebrew/bin or /usr/local/bin; install fb-idb to enable autospawn");
  const proc = spawn(bin, ["--udid", udid, "--grpc-port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  const pid = proc.pid!;
  const endpoint = `localhost:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) throw new Error(`idb_companion exited before becoming ready (pid ${pid})`);
    const got = await probe(endpoint);
    if (got === udid) return pid;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`idb_companion didn't become ready within 8s (pid ${pid}, port ${port})`);
}

function resolveUdid(udid: string): string {
  if (udid && udid !== "booted") return udid;
  const devices = simctl.listDevices() as any;
  const buckets = devices?.devices ?? {};
  const booted: string[] = [];
  for (const list of Object.values(buckets) as any[]) {
    for (const d of list) if (d?.state === "Booted" && d.udid) booted.push(d.udid);
  }
  if (booted.length === 0) throw new Error("no booted simulator; pass --udid <id> or boot one");
  if (booted.length > 1) throw new Error(`multiple booted simulators (${booted.join(", ")}); pass --udid <id>`);
  return booted[0]!;
}

export type ResolveOpts = {
  explicit?: string;
  udid: string;
  autospawn?: boolean;
  log?: (msg: string) => void;
};

export type Resolved = { endpoint: string; udid: string; spawned: boolean };

export async function resolveCompanion(opts: ResolveOpts): Promise<Resolved> {
  const log = opts.log ?? (() => {});
  const autospawn = opts.autospawn !== false;

  if (opts.explicit) {
    return { endpoint: opts.explicit, udid: opts.udid, spawned: false };
  }

  const wantUdid = resolveUdid(opts.udid);

  const reg = loadRegistry();
  const cached = reg[wantUdid];
  if (cached) {
    const stillOurs = cached.pid && pidAlive(cached.pid);
    if (stillOurs) {
      const got = await probe(cached.endpoint);
      if (got === wantUdid) return { endpoint: cached.endpoint, udid: wantUdid, spawned: false };
    }
    delete reg[wantUdid];
    saveRegistry(reg);
  }

  if (!autospawn) throw new Error(`no sim-cli-managed companion for ${wantUdid} and autospawn disabled`);
  const port = await freePort();
  const pid = await spawnCompanion(wantUdid, port);
  const endpoint = `localhost:${port}`;
  const reg2 = loadRegistry();
  reg2[wantUdid] = { endpoint, pid, spawnedAt: Date.now() };
  saveRegistry(reg2);
  log(`spawned idb_companion for ${wantUdid} on ${endpoint} (pid ${pid})`);
  return { endpoint, udid: wantUdid, spawned: true };
}
