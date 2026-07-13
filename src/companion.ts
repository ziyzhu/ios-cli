import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { parse } from "protobufjs";
import { textToKeyEvents } from "./keymap.ts";
import PROTO_SOURCE from "./idb.proto" with { type: "text" };

const root = parse(PROTO_SOURCE).root;
const pkgDef = protoLoader.fromJSON(root.toJSON(), {
  keepCase: true,
  longs: String,
  enums: Number,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as any;
const CompanionService = proto.idb.CompanionService;

export function makeClient(target: string): any {
  if (target.startsWith("/")) target = `unix://${target}`;
  return new CompanionService(target, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
    "grpc.max_send_message_length": 64 * 1024 * 1024,
  });
}

type Pt = { x: number; y: number };

const DOWN = 0;
const UP = 1;
const BACKSPACE = 42;
const A = 4;
const GUI = 227;

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
  const MAX = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise<void>((res, rej) => {
        const call = client.hid((err: any) => (err ? rej(err) : res()));
        for (const e of events) call.write(e);
        call.end();
      });
      return;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const transient = /Mach port not connected|device may not be ready|UNAVAILABLE|INTERNAL/i.test(msg);
      if (!transient || attempt >= MAX) throw err;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
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

export type DragOpts = { press?: number; duration?: number; hold?: number; delta?: number };

export function dragEvents(points: Pt[], opts: DragOpts = {}): any[] {
  if (points.length < 2) throw new Error("drag requires at least two points");
  const delta = opts.delta && opts.delta > 0 ? opts.delta : 10;
  const duration = opts.duration ?? 0.25;
  const evs: any[] = [pressTouch(points[0]!, DOWN)];
  if (opts.press && opts.press > 0) evs.push(delay(opts.press));
  for (let s = 1; s < points.length; s++) {
    const from = points[s - 1]!;
    const to = points[s]!;
    const steps = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / delta));
    for (let i = 1; i <= steps; i++) {
      if (duration > 0) evs.push(delay(duration / steps));
      evs.push(pressTouch({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      }, DOWN));
    }
  }
  if (opts.hold && opts.hold > 0) evs.push(delay(opts.hold));
  evs.push(pressTouch(points[points.length - 1]!, UP));
  return evs;
}

export async function drag(client: any, points: Pt[], opts?: DragOpts) {
  await streamHid(client, dragEvents(points, opts));
}

export async function text(client: any, str: string) {
  const evs = textToKeyEvents(str).map((k) =>
    pressKey(k.keycode, k.down ? DOWN : UP),
  );
  await streamHid(client, evs);
}

export async function replaceText(client: any, str: string) {
  const evs = [
    pressKey(GUI, DOWN),
    pressKey(A, DOWN),
    pressKey(A, UP),
    pressKey(GUI, UP),
    pressKey(BACKSPACE, DOWN),
    pressKey(BACKSPACE, UP),
    ...textToKeyEvents(str).map((k) => pressKey(k.keycode, k.down ? DOWN : UP)),
  ];
  await streamHid(client, evs);
}

const BUTTONS: Record<string, number> = {
  apple_pay: 0, home: 1, lock: 2, side_button: 3, siri: 4,
};

export async function button(client: any, name: string, duration?: number) {
  const code = BUTTONS[name.toLowerCase()];
  if (code === undefined) throw new Error(`button must be one of: ${Object.keys(BUTTONS).join(", ")} (got: "${name}")`);
  const evs: any[] = [pressButton(code, DOWN)];
  if (duration && duration > 0) evs.push(delay(duration));
  evs.push(pressButton(code, UP));
  await streamHid(client, evs);
}

export function simulateMemoryWarning(client: any): Promise<void> {
  return new Promise((res, rej) => {
    client.simulate_memory_warning({}, (err: any) => (err ? rej(err) : res()));
  });
}

export function describeTarget(
  client: any,
  deadlineMs = 800,
): Promise<{ udid: string; name: string; state?: string; os_version?: string }> {
  return new Promise((res, rej) => {
    const deadline = new Date(Date.now() + deadlineMs);
    client.describe({}, { deadline }, (err: any, resp: any) => {
      if (err) return rej(err);
      const t = resp?.target_description ?? resp?.companion ?? {};
      res({
        udid: String(resp?.companion?.udid ?? t.udid ?? ""),
        name: String(t.name ?? ""),
        state: t.state ? String(t.state) : undefined,
        os_version: t.os_version ? String(t.os_version) : undefined,
      });
    });
  });
}

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
