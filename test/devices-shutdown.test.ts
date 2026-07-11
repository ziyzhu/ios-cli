import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("devices shutdown", () => {
  test("shuts down only explicit targets and reports final states", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-shutdown-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const logPath = join(dir, "calls.jsonl");
    const xcrunPath = join(dir, "xcrun");
    writeFileSync(statePath, JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
          { name: "ci-one", udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", state: "Booted", isAvailable: true },
          { name: "ci-two", udid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", state: "Shutdown", isAvailable: true },
          { name: "human", udid: "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC", state: "Booted", isAvailable: true },
        ],
      },
    }));
    writeFileSync(xcrunPath, `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SIM_TEST_LOG, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.SIM_TEST_STATE, "utf8"));
if (args[0] !== "simctl") process.exit(1);
if (args[1] === "list") {
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}
if (args[1] === "shutdown") {
  for (const devices of Object.values(state.devices)) {
    const device = devices.find((candidate) => candidate.udid === args[2]);
    if (device) device.state = "Shutdown";
  }
  writeFileSync(process.env.SIM_TEST_STATE, JSON.stringify(state));
  process.exit(0);
}
process.exit(1);
`);
    chmodSync(xcrunPath, 0o755);

    const result = Bun.spawnSync([
      process.execPath,
      "src/index.ts",
      "devices",
      "shutdown",
      "ci-one",
      "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
    ], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SIM_TEST_STATE: statePath, SIM_TEST_LOG: logPath },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      ok: true,
      devices: [
        { requested: "ci-one", name: "ci-one", udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", state: "Shutdown" },
        { requested: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", name: "ci-two", udid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", state: "Shutdown" },
      ],
    });
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[1] === "shutdown")).toEqual([
      ["simctl", "shutdown", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
    ]);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-0"][2].state).toBe("Booted");
  });

  test("requires explicit targets", () => {
    const result = Bun.spawnSync([process.execPath, "src/index.ts", "devices", "shutdown"], {
      cwd: join(import.meta.dir, ".."),
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.toString())).toEqual({ error: "devices shutdown requires <device>..." });
  });

  test("rejects the implicit booted selector", () => {
    const result = Bun.spawnSync([process.execPath, "src/index.ts", "devices", "shutdown", "booted"], {
      cwd: join(import.meta.dir, ".."),
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.toString())).toEqual({
      error: "devices shutdown requires explicit simulator names or UDIDs, not booted",
    });
  });

  test("publishes the variadic command in help and agent context", () => {
    const cwd = join(import.meta.dir, "..");
    const help = Bun.spawnSync([process.execPath, "src/index.ts", "help", "devices"], { cwd });
    expect(help.stdout.toString()).toContain("shutdown <device...>");
    const context = Bun.spawnSync([process.execPath, "src/index.ts", "agent-context"], { cwd });
    const command = JSON.parse(context.stdout.toString()).commands.devices.subcommands.shutdown;
    expect(command.args).toEqual([{
      name: "device",
      required: true,
      variadic: true,
      description: "one or more simulator names or UDIDs",
    }]);
  });
});
