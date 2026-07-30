import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceArgs } from "../src/instruments.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "sim-instruments-"));
  dirs.push(dir);
  return dir;
}

function stubTools(dir: string): { state: string; calls: string; notifications: string } {
  const state = join(dir, "state.json");
  const calls = join(dir, "calls.jsonl");
  const notifications = join(dir, "notifications");
  mkdirSync(notifications);
  writeFileSync(state, JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        { name: "trace-sim", udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", state: "Booted", isAvailable: true },
      ],
    },
  }));
  writeFileSync(join(dir, "xcrun"), `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.SIM_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "simctl" && args[1] === "list") {
  process.stdout.write(readFileSync(process.env.SIM_TEST_STATE, "utf8"));
  process.exit(0);
}
if (args[0] === "simctl" && args[1] === "spawn") {
  process.stdout.write("4321\\t0\\tUIKitApplication:com.example.app[stub]\\n");
  process.exit(0);
}
if (args[0] === "simctl" && args[1] === "listapps") {
  process.stdout.write('{ "com.example.app" = { CFBundleExecutable = Example; }; }\\n');
  process.exit(0);
}
if (args[0] === "xctrace" && args[1] === "record") {
  const notification = args[args.indexOf("--notify-tracing-started") + 1];
  const output = args[args.indexOf("--output") + 1];
  writeFileSync(join(process.env.SIM_TEST_NOTIFICATIONS, notification), "ready");
  process.on("SIGINT", () => {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "recording.json"), JSON.stringify({ args }));
    process.exit(0);
  });
  await new Promise(() => {});
}
process.stderr.write("unexpected xcrun args: " + JSON.stringify(args) + "\\n");
process.exit(1);
`);
  writeFileSync(join(dir, "notifyutil"), `#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
const notification = process.argv[3];
const marker = join(process.env.SIM_TEST_NOTIFICATIONS, notification);
const deadline = Date.now() + 5000;
while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
process.exit(existsSync(marker) ? 0 : 1);
`);
  chmodSync(join(dir, "xcrun"), 0o755);
  chmodSync(join(dir, "notifyutil"), 0o755);
  return { state, calls, notifications };
}

function sim(home: string, args: string[], env: Record<string, string>) {
  return Bun.spawnSync([process.execPath, "src/index.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: home, PATH: `${home}:${process.env.PATH}`, ...env },
  });
}

describe("Instruments traces", () => {
  test("builds an xctrace invocation from stable template names", () => {
    expect(traceArgs({
      udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      process: "Example",
      template: "time-profiler",
      file: "/tmp/view.trace",
      notification: "ai.sim-cli.ready",
    })).toEqual([
      "xctrace", "record",
      "--template", "Time Profiler",
      "--device", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "--attach", "Example",
      "--output", "/tmp/view.trace",
      "--notify-tracing-started", "ai.sim-cli.ready",
    ]);
  });

  test("starts against a bundle id and stops after the trace package finalizes", () => {
    const home = sandbox();
    const tools = stubTools(home);
    const env = {
      SIM_TEST_STATE: tools.state,
      SIM_TEST_CALLS: tools.calls,
      SIM_TEST_NOTIFICATIONS: tools.notifications,
    };
    const output = join(home, "interaction.trace");
    const started = sim(home, [
      "--device", "trace-sim", "trace", "start", "com.example.app",
      "--template", "time-profiler", "--out", output,
    ], env);
    expect(started.exitCode, started.stderr.toString()).toBe(0);
    const startResult = JSON.parse(started.stdout.toString());
    expect(startResult).toMatchObject({
      appPid: 4321,
      process: "Example",
      bundle: "com.example.app",
      device: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      template: "time-profiler",
      instrumentTemplate: "Time Profiler",
      file: output,
    });
    expect(existsSync(output)).toBe(false);

    const stopped = sim(home, ["--device", "trace-sim", "trace", "stop"], env);
    expect(stopped.exitCode).toBe(0);
    expect(JSON.parse(stopped.stdout.toString())).toMatchObject({
      pid: startResult.pid,
      file: output,
      stopped: true,
      completed: true,
    });
    expect(existsSync(join(output, "recording.json"))).toBe(true);

    const calls = readFileSync(tools.calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toContainEqual([
      "xctrace", "record",
      "--template", "Time Profiler",
      "--device", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "--attach", "Example",
      "--output", output,
      "--notify-tracing-started", expect.stringMatching(/^ai\.sim-cli\.trace\./),
    ]);
  });

  test("publishes templates through help and agent context", () => {
    const home = sandbox();
    const help = sim(home, ["help", "trace"], {});
    expect(help.stdout.toString()).toContain("--template <time-profiler>");
    const context = sim(home, ["agent-context"], {});
    const document = JSON.parse(context.stdout.toString());
    expect(document.schema_version).toBe("3");
    expect(document.commands.trace.flags[0]).toMatchObject({
      name: "template",
      type: "enum",
      values: ["time-profiler"],
    });
    expect(document.commands.trace.subcommands.export.args[0]).toMatchObject({ name: "file.trace", required: true });
  });
});
