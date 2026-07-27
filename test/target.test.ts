import { describe, expect, test } from "bun:test";
import { parsePhysicalDevices } from "../src/devicectl.ts";
import { parseSimulators, resolveTargetSpec } from "../src/target.ts";

const simulatorDocument = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { name: "mango-qa", udid: "3C55382A-971A-47F0-9C3F-B83816C23ECD", state: "Booted", isAvailable: true },
      { name: "shared", udid: "66BF7B5D-89D9-41CA-A268-D7D01A324D3C", state: "Booted", isAvailable: true },
    ],
  },
};

const physicalDocument = {
  result: {
    devices: [
      {
        identifier: "25BC245F-B0C5-52B0-9DC2-7308D8644735",
        connectionProperties: { transportType: "localNetwork", tunnelState: "disconnected" },
        deviceProperties: { name: "iPhone", osVersionNumber: "26.5.2", developerModeStatus: "enabled" },
        hardwareProperties: { reality: "physical", platform: "iOS", udid: "00008150-000E02901420401C", marketingName: "iPhone 17 Pro Max" },
      },
      {
        identifier: "3F09D0DD-B03F-50E8-9CF8-ED210E7667B6",
        connectionProperties: {},
        deviceProperties: { name: "shared", osVersionNumber: "18.6.2", developerModeStatus: "enabled" },
        hardwareProperties: { reality: "physical", platform: "iOS", udid: "00008120-00060884119B401E", marketingName: "iPhone 14 Pro Max" },
      },
    ],
  },
};

describe("target inventory", () => {
  const simulators = parseSimulators(simulatorDocument);
  const physicalDevices = parsePhysicalDevices(physicalDocument);

  test("normalizes simulator and physical device state", () => {
    expect(simulators[0]).toMatchObject({ kind: "simulator", name: "mango-qa", state: "Booted", runtime: "iOS-26-0" });
    expect(physicalDevices[0]).toMatchObject({ kind: "physical", name: "iPhone", state: "Available", available: true, osVersion: "26.5.2" });
    expect(physicalDevices[1]).toMatchObject({ name: "shared", state: "Unavailable", available: false });
  });

  test("resolves physical devices by name, hardware UDID, and CoreDevice identifier", () => {
    const inventory = { simulators, physicalDevices };
    expect(resolveTargetSpec("iPhone", inventory)).toMatchObject({ kind: "physical", udid: "00008150-000E02901420401C" });
    expect(resolveTargetSpec("00008150-000E02901420401C", inventory)).toMatchObject({ kind: "physical", name: "iPhone" });
    expect(resolveTargetSpec("25BC245F-B0C5-52B0-9DC2-7308D8644735", inventory)).toMatchObject({ kind: "physical", name: "iPhone" });
  });

  test("preserves booted as the implicit simulator target", () => {
    expect(resolveTargetSpec("booted", { simulators, physicalDevices })).toEqual({
      kind: "simulator", name: "booted", udid: "booted", state: "Booted", available: true,
    });
  });

  test("rejects names shared by a simulator and physical device", () => {
    expect(() => resolveTargetSpec("shared", { simulators, physicalDevices })).toThrow("matches 2 targets");
  });
});
