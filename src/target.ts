import * as devicectl from "./devicectl.ts";
import * as simctl from "./simctl.ts";

export interface SimulatorTarget {
  kind: "simulator";
  name: string;
  udid: string;
  state: string;
  available: boolean;
  runtime?: string;
}

export type Target = SimulatorTarget | devicectl.PhysicalDevice;

export interface TargetInventory {
  simulators: SimulatorTarget[];
  physicalDevices: devicectl.PhysicalDevice[];
}

const SIMULATOR_UDID = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;
const PHYSICAL_UDID = /^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/i;

export function parseSimulators(document: any): SimulatorTarget[] {
  const simulators: SimulatorTarget[] = [];
  for (const [runtimeId, devices] of Object.entries(document?.devices ?? {}) as [string, any[]][]) {
    for (const device of devices) {
      if (!device?.udid || !device?.name || device?.isAvailable === false) continue;
      simulators.push({
        kind: "simulator",
        name: String(device.name),
        udid: String(device.udid),
        state: String(device.state ?? "Unknown"),
        available: true,
        runtime: runtimeId.split(".").pop() ?? runtimeId,
      });
    }
  }
  return simulators;
}

export function inventory(): TargetInventory {
  return {
    simulators: parseSimulators(simctl.listDevices()),
    physicalDevices: devicectl.tryListDevices(),
  };
}

export function listAll(): unknown {
  const simulators = simctl.listDevices() as Record<string, unknown>;
  return { ...simulators, physicalDevices: devicectl.tryListDevices() };
}

export function resolveTargetSpec(spec: string, targets: TargetInventory = inventory()): Target {
  if (spec === "booted") {
    return { kind: "simulator", name: "booted", udid: "booted", state: "Booted", available: true };
  }
  const normalized = spec.toLowerCase();
  const identifiers = [
    ...targets.simulators.filter((target) => target.udid.toLowerCase() === normalized),
    ...targets.physicalDevices.filter((target) => target.udid.toLowerCase() === normalized || target.identifier.toLowerCase() === normalized),
  ];
  if (identifiers.length === 1) return identifiers[0]!;
  if (identifiers.length > 1) throw new Error(`"${spec}" matches multiple targets; pass a unique UDID`);
  const names = [
    ...targets.simulators.filter((target) => target.name.toLowerCase() === normalized),
    ...targets.physicalDevices.filter((target) => target.name.toLowerCase() === normalized),
  ];
  const booted = names.filter((target) => target.kind === "simulator" && target.state === "Booted");
  if (names.length === 1) return names[0]!;
  if (booted.length === 1 && names.every((target) => target.kind === "simulator")) return booted[0]!;
  if (names.length > 1) {
    throw new Error(`"${spec}" matches ${names.length} targets: ${names.map(describeTarget).join(", ")}; pass --device <udid>`);
  }
  if (PHYSICAL_UDID.test(spec)) {
    return {
      kind: "physical",
      name: spec,
      udid: spec,
      identifier: spec,
      state: "Unavailable",
      available: false,
      platform: "iOS",
    };
  }
  if (SIMULATOR_UDID.test(spec)) {
    return { kind: "simulator", name: spec, udid: spec, state: "Unknown", available: true };
  }
  throw new Error(`no simulator or physical iOS device named "${spec}"; see \`sim devices\``);
}

function describeTarget(target: Target): string {
  const detail = target.kind === "physical" ? `${target.platform} device` : target.runtime ?? "simulator";
  return `${target.udid} [${detail}, ${target.state}]`;
}
