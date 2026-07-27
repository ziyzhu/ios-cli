import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type BuildPlatform = "simulator" | "device";

export interface BuildOpts {
  workspace?: string;
  project?: string;
  scheme: string;
  configuration?: string;
  derivedData?: string;
  platform?: BuildPlatform;
  destinationUdid?: string;
}

export function detectXcodeProject(cwd: string = process.cwd()): { workspace?: string; project?: string } {
  let entries: string[] = [];
  try { entries = readdirSync(cwd).sort(); } catch { return {}; }
  const workspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
  if (workspace) return { workspace: join(cwd, workspace) };
  const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
  return project ? { project: join(cwd, project) } : {};
}

export function detectScheme(opts: { workspace?: string; project?: string }): string | undefined {
  const args = ["-list", "-json"];
  if (opts.workspace) args.push("-workspace", opts.workspace);
  else if (opts.project) args.push("-project", opts.project);
  const result = spawnSync("xcodebuild", args, { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    const document = JSON.parse(result.stdout);
    const schemes: string[] = document.workspace?.schemes ?? document.project?.schemes ?? [];
    return schemes.length === 1 ? schemes[0] : undefined;
  } catch { return undefined; }
}

function hasXcpretty(): boolean {
  return spawnSync("bash", ["-c", "command -v xcpretty"], { encoding: "utf8" }).status === 0;
}

export function buildArgs(opts: BuildOpts): string[] {
  const args: string[] = [];
  if (opts.workspace) args.push("-workspace", opts.workspace);
  else if (opts.project) args.push("-project", opts.project);
  args.push("-scheme", opts.scheme, "-configuration", opts.configuration ?? "Debug");
  if ((opts.platform ?? "simulator") === "device") {
    args.push("-sdk", "iphoneos", "-destination", opts.destinationUdid ? `id=${opts.destinationUdid}` : "generic/platform=iOS", "-allowProvisioningUpdates");
  } else {
    args.push("-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator");
  }
  if (opts.derivedData) args.push("-derivedDataPath", opts.derivedData);
  return args;
}

function parseBuiltApp(stdout: string): string | undefined {
  try {
    const targets = JSON.parse(stdout) as Array<{ buildSettings?: Record<string, string> }>;
    for (const { buildSettings } of targets) {
      const wrapper = buildSettings?.WRAPPER_EXTENSION;
      const dir = buildSettings?.TARGET_BUILD_DIR;
      const name = buildSettings?.FULL_PRODUCT_NAME;
      if (wrapper === "app" && dir && name) return join(dir, name);
    }
  } catch { return undefined; }
  return undefined;
}

export function resolveBuiltApp(opts: BuildOpts): string | undefined {
  const result = spawnSync("xcodebuild", [...buildArgs(opts), "-showBuildSettings", "-json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return undefined;
  return parseBuiltApp(result.stdout);
}

export function resolveBuiltAppAsync(opts: BuildOpts): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("xcodebuild", [...buildArgs(opts), "-showBuildSettings", "-json"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(undefined));
    child.on("exit", (code) => resolve(code === 0 ? parseBuiltApp(Buffer.concat(chunks).toString("utf8")) : undefined));
  });
}

export async function build(opts: BuildOpts): Promise<void> {
  const args = [...buildArgs(opts), "build"];
  const child = hasXcpretty()
    ? spawn("bash", ["-c", `set -o pipefail; xcodebuild ${args.map(shellQuote).join(" ")} | xcpretty`], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn("xcodebuild", args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout!.on("data", (chunk) => chunks.push(chunk));
  child.stderr!.on("data", (chunk) => chunks.push(chunk));
  const code: number = await new Promise((resolve) => child.on("exit", (value) => resolve(value ?? 1)));
  if (code !== 0) {
    process.stderr.write(Buffer.concat(chunks));
    throw new Error(`xcodebuild failed (exit ${code})`);
  }
}

export function findDerivedApp(bundleId: string, platform: BuildPlatform): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const root = join(home, "Library", "Developer", "Xcode", "DerivedData");
  const suffix = platform === "device" ? "iphoneos" : "iphonesimulator";
  const result = spawnSync("find", [root, "-type", "d", "-path", `*/Build/Products/Debug-${suffix}/*.app`, "-prune", "-print"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const candidates = result.stdout.split("\n").filter(Boolean).sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
  });
  for (const app of candidates) {
    const plist = join(app, "Info.plist");
    const id = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8" });
    if (id.status === 0 && id.stdout.trim() === bundleId) return app;
  }
  return undefined;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
