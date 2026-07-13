import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shape } from "../src/invocations.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "sim-invocations-"));
  dirs.push(dir);
  return dir;
}

function stubXcrun(dir: string) {
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        { name: "ci-one", udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", state: "Booted", isAvailable: true },
      ],
    },
  }));
  const xcrunPath = join(dir, "xcrun");
  writeFileSync(xcrunPath, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.SIM_TEST_STATE, "utf8"));
if (args[1] === "list") { process.stdout.write(JSON.stringify(state)); process.exit(0); }
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
  return statePath;
}

function run(home: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "src/index.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: home, PATH: `${home}:${process.env.PATH}`, ...env },
  });
}

function records(home: string): any[] {
  const file = join(home, ".sim-cli", "logs", "invocations.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("shape", () => {
  test("keeps fields and types, samples arrays, drops values", () => {
    expect(shape({ path: "/tmp/a.png", base64: "iVBORw0K", tries: 3, ok: true, err: null })).toEqual({
      path: "string", base64: "string", tries: "number", ok: "boolean", err: "null",
    });
    expect(shape({ devices: [{ udid: "A", state: "Booted" }, { udid: "B", state: "Shutdown" }] })).toEqual({
      devices: [{ udid: "string", state: "string" }],
    });
    expect(shape({ devices: [] })).toEqual({ devices: [] });
  });

  test("collapses dictionaries keyed by data into a single entry", () => {
    expect(shape({
      "AAAA-1": { endpoint: "localhost:1", pid: 1, alive: true },
      "BBBB-2": { endpoint: "localhost:2", pid: 2, alive: false },
      "CCCC-3": { endpoint: "localhost:3", pid: 3, alive: true },
    })).toEqual({ "*": { endpoint: "string", pid: "number", alive: "boolean" } });
  });

  test("does not collapse records that merely share a value type", () => {
    expect(shape({ requested: "ci-one", name: "ci-one", udid: "AAAA", state: "Shutdown" })).toEqual({
      requested: "string", name: "string", udid: "string", state: "string",
    });
  });
});

describe("invocation log", () => {
  test("appends one record per invocation with the output shape, not its content", () => {
    const home = sandbox();
    const statePath = stubXcrun(home);

    const result = run(home, ["devices", "shutdown", "ci-one"], { SIM_TEST_STATE: statePath });
    expect(result.exitCode).toBe(0);

    const [record, ...rest] = records(home);
    expect(rest).toEqual([]);
    expect(record.cmd).toBe("devices");
    expect(record.argv).toEqual(["devices", "shutdown", "ci-one"]);
    expect(record.exit).toBe(0);
    expect(record.error).toBeUndefined();
    expect(record.output).toEqual({
      ok: "boolean",
      devices: [{ requested: "string", name: "string", udid: "string", state: "string" }],
    });
    expect(typeof record.ms).toBe("number");
    expect(record.cwd).toBe(join(import.meta.dir, ".."));

    run(home, ["devices", "shutdown", "ci-one"], { SIM_TEST_STATE: statePath });
    expect(records(home)).toHaveLength(2);
  });

  test("records failures with the exit code and message", () => {
    const home = sandbox();
    const result = run(home, ["devices", "shutdown"]);
    expect(result.exitCode).toBe(1);

    const [record] = records(home);
    expect(record.exit).toBe(1);
    expect(record.error).toBe("devices shutdown requires <device>...");
    expect(record.output).toBeUndefined();
  });

  test("redacts --env values", () => {
    const home = sandbox();
    run(home, ["run", "com.example.app", "--env", "TOKEN=hunter2", "--app", "/nope.app"]);

    const [record] = records(home);
    expect(record.argv).toContain("TOKEN=***");
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

});
