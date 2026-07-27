import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PhysicalDevice {
  kind: "physical";
  name: string;
  udid: string;
  identifier: string;
  state: "Available" | "Unavailable";
  available: boolean;
  platform: string;
  model?: string;
  osVersion?: string;
  developerMode?: string;
  connection?: string;
}

type Document = { info?: { outcome?: string; errors?: unknown[] }; result?: Record<string, any> };

export function runJson(args: string[]): Record<string, any> {
  const dir = mkdtempSync(join(tmpdir(), "sim-cli-devicectl-"));
  const output = join(dir, "result.json");
  const process = spawnSync("xcrun", ["devicectl", "--json-output", output, "--quiet", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let document: Document = {};
  try {
    if (existsSync(output)) document = JSON.parse(readFileSync(output, "utf8"));
  } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  if (process.status !== 0 || document.info?.outcome === "failure") {
    throw new Error(devicectlError(document, process.stderr || process.stdout));
  }
  return document.result ?? {};
}

export function parsePhysicalDevices(document: Document): PhysicalDevice[] {
  const raw = document.result?.devices ?? [];
  return raw.flatMap((device: any) => {
    const hardware = device.hardwareProperties ?? {};
    const properties = device.deviceProperties ?? {};
    const connection = device.connectionProperties ?? {};
    if (hardware.reality !== "physical" || hardware.platform !== "iOS") return [];
    const udid = String(hardware.udid ?? "");
    const identifier = String(device.identifier ?? "");
    const name = String(properties.name ?? "");
    if (!udid || !identifier || !name) return [];
    const available = Boolean(connection.transportType) || properties.ddiServicesAvailable === true;
    return [{
      kind: "physical" as const,
      name,
      udid,
      identifier,
      state: available ? "Available" as const : "Unavailable" as const,
      available,
      platform: String(hardware.platform),
      ...(hardware.marketingName ? { model: String(hardware.marketingName) } : {}),
      ...(properties.osVersionNumber ? { osVersion: String(properties.osVersionNumber) } : {}),
      ...(properties.developerModeStatus ? { developerMode: String(properties.developerModeStatus) } : {}),
      ...(connection.transportType ? { connection: String(connection.transportType) } : {}),
    }];
  });
}

export function listDevices(): PhysicalDevice[] {
  const result = runJson(["list", "devices"]);
  return parsePhysicalDevices({ result });
}

export function tryListDevices(): PhysicalDevice[] {
  try { return listDevices(); } catch { return []; }
}

export function listApps(device: PhysicalDevice): unknown[] {
  return runJson(["device", "info", "apps", "--device", device.udid]).apps ?? [];
}

export function install(device: PhysicalDevice, appPath: string): Record<string, any> {
  return runJson(["device", "install", "app", "--device", device.udid, appPath]);
}

export function uninstall(device: PhysicalDevice, bundleId: string): Record<string, any> {
  return runJson(["device", "uninstall", "app", "--device", device.udid, bundleId]);
}

export function launch(
  device: PhysicalDevice,
  bundleId: string,
  args: string[],
  env: Record<string, string>,
): { pid: number; result: Record<string, any> } {
  const command = ["device", "process", "launch", "--device", device.udid, "--terminate-existing"];
  if (Object.keys(env).length > 0) command.push("--environment-variables", JSON.stringify(env));
  command.push("--", bundleId, ...args);
  const result = runJson(command);
  return { pid: findProcessIdentifier(result), result };
}

function findProcessIdentifier(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  for (const [key, child] of Object.entries(value)) {
    if (/processIdentifier|process_id|pid/i.test(key) && typeof child === "number") return child;
    const nested = findProcessIdentifier(child);
    if (nested > 0) return nested;
  }
  return 0;
}

function devicectlError(document: Document, fallback: string): string {
  const errors = document.info?.errors ?? [];
  const messages = errors.flatMap((error) => collectMessages(error));
  return messages.find(Boolean) ?? (fallback.trim() || "devicectl failed");
}

function collectMessages(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const own = [object.description, object.failureReason, object.recoverySuggestion, object.message]
    .filter((entry): entry is string => typeof entry === "string");
  return [...own, ...Object.values(object).flatMap((entry) => collectMessages(entry))];
}
