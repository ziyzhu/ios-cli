import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeFingerprint } from "../src/build.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "sim-build-"));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  expect(r.status).toBe(0);
}

function repo(dir: string): string {
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "main.swift"), "print(1)\n");
  git(repoDir, "init", "-q");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-qm", "init");
  return repoDir;
}

describe("treeFingerprint", () => {
  test("is undefined outside a git repo", () => {
    expect(treeFingerprint(sandbox())).toBeUndefined();
  });

  test("is stable while the tree is unchanged", () => {
    const repoDir = repo(sandbox());
    expect(treeFingerprint(repoDir)).toBe(treeFingerprint(repoDir)!);
  });

  test("changes when a tracked file is modified and when an untracked file appears", () => {
    const repoDir = repo(sandbox());
    const clean = treeFingerprint(repoDir)!;
    writeFileSync(join(repoDir, "main.swift"), "print(2)\n");
    const dirty = treeFingerprint(repoDir)!;
    expect(dirty).not.toBe(clean);
    writeFileSync(join(repoDir, "new.swift"), "print(3)\n");
    expect(treeFingerprint(repoDir)!).not.toBe(dirty);
  });

  test("changes when HEAD moves", () => {
    const repoDir = repo(sandbox());
    const before = treeFingerprint(repoDir)!;
    writeFileSync(join(repoDir, "main.swift"), "print(2)\n");
    git(repoDir, "commit", "-aqm", "edit");
    expect(treeFingerprint(repoDir)!).not.toBe(before);
  });
});

function stubXcodebuild(home: string) {
  const path = join(home, "xcodebuild");
  writeFileSync(path, `#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
const dir = process.env.SIM_TEST_BUILD_DIR;
if (args.includes("-showBuildSettings")) {
  process.stdout.write(JSON.stringify([{ buildSettings: {
    WRAPPER_EXTENSION: "app", TARGET_BUILD_DIR: dir, FULL_PRODUCT_NAME: "Fake.app",
  } }]));
  process.exit(0);
}
if (args.includes("build")) {
  mkdirSync(\`\${dir}/Fake.app\`, { recursive: true });
  appendFileSync(\`\${dir}/builds.log\`, args.join(" ") + "\\n");
  process.exit(0);
}
process.exit(1);
`);
  chmodSync(path, 0o755);
}

function simBuild(home: string, repoDir: string, buildDir: string, ...extra: string[]) {
  const r = Bun.spawnSync(
    [process.execPath, "src/index.ts", "build", "--project", join(repoDir, "fake.xcodeproj"), "--scheme", "Fake", ...extra],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, HOME: home, PATH: `${home}:${process.env.PATH}`, SIM_TEST_BUILD_DIR: buildDir },
    },
  );
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString()) as { app: string; skipped?: boolean };
}

function buildCount(buildDir: string): number {
  if (!existsSync(join(buildDir, "builds.log"))) return 0;
  return readFileSync(join(buildDir, "builds.log"), "utf8").trim().split("\n").length;
}

describe("build skip", () => {
  test("skips xcodebuild when the tree is unchanged, rebuilds on change or --force", () => {
    const home = sandbox();
    stubXcodebuild(home);
    const repoDir = repo(home);
    mkdirSync(join(repoDir, "fake.xcodeproj"), { recursive: true });
    writeFileSync(join(repoDir, "fake.xcodeproj", "project.pbxproj"), "{}\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-qm", "project");
    const buildDir = join(home, "products");
    mkdirSync(buildDir, { recursive: true });

    const first = simBuild(home, repoDir, buildDir);
    expect(first.app).toBe(join(buildDir, "Fake.app"));
    expect(first.skipped).toBeUndefined();
    expect(buildCount(buildDir)).toBe(1);

    const second = simBuild(home, repoDir, buildDir);
    expect(second.app).toBe(first.app);
    expect(second.skipped).toBe(true);
    expect(buildCount(buildDir)).toBe(1);

    writeFileSync(join(repoDir, "main.swift"), "print(9)\n");
    const third = simBuild(home, repoDir, buildDir);
    expect(third.skipped).toBeUndefined();
    expect(buildCount(buildDir)).toBe(2);

    const fourth = simBuild(home, repoDir, buildDir, "--force");
    expect(fourth.skipped).toBeUndefined();
    expect(buildCount(buildDir)).toBe(3);
  });

  test("rebuilds when the cached .app has been deleted", () => {
    const home = sandbox();
    stubXcodebuild(home);
    const repoDir = repo(home);
    mkdirSync(join(repoDir, "fake.xcodeproj"), { recursive: true });
    writeFileSync(join(repoDir, "fake.xcodeproj", "project.pbxproj"), "{}\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-qm", "project");
    const buildDir = join(home, "products");
    mkdirSync(buildDir, { recursive: true });

    simBuild(home, repoDir, buildDir);
    rmSync(join(buildDir, "Fake.app"), { recursive: true, force: true });
    const again = simBuild(home, repoDir, buildDir);
    expect(again.skipped).toBeUndefined();
    expect(buildCount(buildDir)).toBe(2);
  });
});
