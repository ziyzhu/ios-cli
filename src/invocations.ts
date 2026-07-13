import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Shape = string | Shape[] | { [key: string]: Shape };

const MAX_DEPTH = 6;

export function invocationsPath(): string {
  return join(homedir(), ".sim-cli", "logs", "invocations.jsonl");
}

export function invocationsFile(): { file: string; size: number; modified: string } | undefined {
  const file = invocationsPath();
  if (!existsSync(file)) return undefined;
  const stat = statSync(file);
  return { file, size: stat.size, modified: stat.mtime.toISOString() };
}

export function shape(value: unknown, depth = 0): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "array";
    return value.length ? [shape(value[0], depth + 1)] : [];
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "object";
    const entries = Object.entries(value).map(([key, member]) => [key, shape(member, depth + 1)] as const);
    if (isKeyedMap(entries)) return { "*": entries[0]![1] };
    return Object.fromEntries(entries);
  }
  return typeof value;
}

function isKeyedMap(entries: readonly (readonly [string, Shape])[]): boolean {
  if (entries.length < 3) return false;
  if (entries.some(([, member]) => typeof member === "string")) return false;
  const first = JSON.stringify(entries[0]![1]);
  return entries.every(([, member]) => JSON.stringify(member) === first);
}

function redact(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] !== "--env") continue;
    const eq = out[i + 1]!.indexOf("=");
    out[i + 1] = eq > 0 ? `${out[i + 1]!.slice(0, eq)}=***` : "***";
  }
  return out;
}

let pending: { at: number; argv: string[] } | undefined;
let output: Shape | undefined;
let error: string | undefined;

export function begin(argv: string[]) {
  pending = { at: Date.now(), argv: redact(argv) };
  process.on("exit", flush);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
}

export function recordOutput(data: unknown) {
  if (pending && data !== undefined) output = shape(data);
}

export function recordError(message: string) {
  if (pending) error = message;
}

function flush(exit: number) {
  if (!pending) return;
  const { at, argv } = pending;
  pending = undefined;
  try {
    const file = invocationsPath();
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, JSON.stringify({
      ts: new Date(at).toISOString(),
      ms: Date.now() - at,
      cmd: argv.find((arg) => !arg.startsWith("-")) ?? "",
      argv,
      cwd: process.cwd(),
      pid: process.pid,
      exit,
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
    }) + "\n");
  } catch {}
}
