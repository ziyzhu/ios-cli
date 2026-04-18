import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { textToKeyEvents } from "./keymap.ts";

const PROTO_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./idb.proto",
);

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: Number,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as any;
const CompanionService = proto.idb.CompanionService;

export function makeClient(target: string): any {
  // Accept "host:port", "unix:/path", "unix:///path", or a bare "/path/to.sock".
  if (target.startsWith("/")) target = `unix://${target}`;
  return new CompanionService(target, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
    "grpc.max_send_message_length": 64 * 1024 * 1024,
  });
}

// ---- HID helpers ----

type Pt = { x: number; y: number };

const DOWN = 0;
const UP = 1;

function pressTouch(p: Pt, dir: number) {
  return { press: { action: { touch: { point: p } }, direction: dir } };
}
function pressKey(keycode: number, dir: number) {
  return { press: { action: { key: { keycode } }, direction: dir } };
}
function pressButton(button: number, dir: number) {
  return { press: { action: { button: { button } }, direction: dir } };
}
function delay(seconds: number) {
  return { delay: { duration: seconds } };
}

async function streamHid(client: any, events: any[]): Promise<void> {
  await new Promise<void>((res, rej) => {
    const call = client.hid((err: any) => (err ? rej(err) : res()));
    for (const e of events) call.write(e);
    call.end();
  });
}

export async function tap(client: any, x: number, y: number, duration?: number) {
  const evs: any[] = [pressTouch({ x, y }, DOWN)];
  if (duration && duration > 0) evs.push(delay(duration));
  evs.push(pressTouch({ x, y }, UP));
  await streamHid(client, evs);
}

export async function swipe(
  client: any,
  start: Pt,
  end: Pt,
  duration?: number,
  delta?: number,
) {
  await streamHid(client, [
    { swipe: { start, end, duration: duration ?? 0, delta: delta ?? 0 } },
  ]);
}

export async function text(client: any, str: string) {
  const evs = textToKeyEvents(str).map((k) =>
    pressKey(k.keycode, k.down ? DOWN : UP),
  );
  await streamHid(client, evs);
}

const BUTTONS: Record<string, number> = {
  apple_pay: 0, home: 1, lock: 2, side_button: 3, siri: 4,
};

export async function button(client: any, name: string, duration?: number) {
  const code = BUTTONS[name.toLowerCase()];
  if (code === undefined) throw new Error(`Unknown button: ${name}`);
  const evs: any[] = [pressButton(code, DOWN)];
  if (duration && duration > 0) evs.push(delay(duration));
  evs.push(pressButton(code, UP));
  await streamHid(client, evs);
}

// ---- Accessibility ----

export function describe(
  client: any,
  point?: Pt,
  nested = true,
): Promise<unknown> {
  const req: any = { format: nested ? 1 : 0 };
  if (point) req.point = point;
  return new Promise((res, rej) => {
    client.accessibility_info(req, (err: any, resp: any) => {
      if (err) return rej(err);
      try { res(JSON.parse(resp.json)); } catch { res(resp.json); }
    });
  });
}
