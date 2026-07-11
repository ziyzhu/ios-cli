import { spawnSync } from "node:child_process";
import * as simctl from "./simctl.ts";

export const DEFAULT_PORT = 9909;

interface Listener { port: number; pid: number; process: string }

const UDID_IN_PATH = /CoreSimulator\/Devices\/([0-9A-Fa-f-]{36})\//;

function portsByPid(): Map<number, Set<number>> {
  const byPid = new Map<number, Set<number>>();
  const r = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8" });
  if (r.status !== 0) return byPid;
  let pid = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n")) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (!pid || !Number.isInteger(port)) continue;
      let ports = byPid.get(pid);
      if (!ports) byPid.set(pid, ports = new Set());
      ports.add(port);
    }
  }
  return byPid;
}

function listenersByUdid(): Map<string, Listener[]> {
  const byPid = portsByPid();
  const out = new Map<string, Listener[]>();
  if (byPid.size === 0) return out;
  const ps = spawnSync("ps", ["-o", "pid=,command=", "-p", [...byPid.keys()].join(",")], { encoding: "utf8" });
  if (ps.status !== 0) return out;
  for (const line of ps.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const udid = m[2]!.match(UDID_IN_PATH)?.[1]?.toUpperCase();
    if (!udid) continue;
    const pid = Number(m[1]);
    const exe = m[2]!.split(" ")[0]!;
    const process = exe.slice(exe.lastIndexOf("/") + 1);
    let listeners = out.get(udid);
    if (!listeners) out.set(udid, listeners = []);
    for (const port of [...byPid.get(pid)!].sort((a, b) => a - b)) {
      listeners.push({ port, pid, process });
    }
  }
  return out;
}

function devices() {
  const raw = simctl.listDevices() as { devices?: Record<string, unknown[]> };
  const listeners = listenersByUdid();
  const flat = [];
  for (const [runtime, list] of Object.entries(raw.devices ?? {})) {
    for (const d of list as any[]) {
      if (!d?.isAvailable) continue;
      flat.push({
        name: d.name,
        udid: d.udid,
        state: d.state,
        runtime: runtime.split(".").pop(),
        deviceType: d.deviceTypeIdentifier?.split(".").pop(),
        listeners: listeners.get(String(d.udid).toUpperCase()) ?? [],
      });
    }
  }
  return { devices: flat };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

export function startDaemon(port: number) {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return json({ ok: true });
      if (path === "/devices") return json(devices());
      return json({ error: "not found" }, 404);
    },
  });
  process.stderr.write(`sim daemon listening on http://127.0.0.1:${port}\n`);
}
