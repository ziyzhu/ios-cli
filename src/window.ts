import { spawnSync } from "node:child_process";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function osascript(script: string): string {
  const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
  if (r.status !== 0) {
    const err = (r.stderr ?? "").trim();
    if (err.includes("assistive access")) {
      throw new Error("the terminal needs Accessibility permission (System Settings > Privacy & Security > Accessibility)");
    }
    if (/can.t get process/i.test(err)) throw new Error("Simulator is not running");
    throw new Error(err || "osascript failed");
  }
  return r.stdout;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface Rect { x: number; y: number; w: number; h: number }

function screenInfo(): { main: Rect; count: number } {
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e",
    `ObjC.import("AppKit"); const ss = $.NSScreen.screens.js; const f = ss[0].frame;
     JSON.stringify({count: ss.length, main: {x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height}})`,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr ?? "").trim() || "osascript failed");
  return JSON.parse(r.stdout);
}

function windowFrame(title: string): Rect {
  const out = osascript(`tell application "System Events" to tell process "Simulator"
set p to position of window ${quote(title)}
set s to size of window ${quote(title)}
return ((item 1 of p) as text) & "," & ((item 2 of p) as text) & "," & ((item 1 of s) as text) & "," & ((item 2 of s) as text)
end tell`);
  const [x, y, w, h] = out.trim().split(",").map(Number);
  return { x: x!, y: y!, w: w!, h: h! };
}

async function gatherToMainScreen(title: string, screens: { main: Rect; count: number }): Promise<void> {
  for (let hop = 0; hop < screens.count - 1; hop++) {
    const f = windowFrame(title);
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const m = screens.main;
    if (cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) return;
    rectangle("next-display");
    await sleep(400);
  }
}

function rectangle(action: string): void {
  const r = spawnSync("open", ["-g", `rectangle://execute-action?name=${action}`], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error((r.stderr ?? "").trim() || "Rectangle is not installed (https://rectangleapp.com)");
  }
}

// repeating an action on a window already in that position makes Rectangle
// cycle it to the next slot; centering first makes placement idempotent
async function place(position: string): Promise<void> {
  rectangle("center");
  await sleep(300);
  rectangle(position);
  await sleep(350);
}

function raise(title: string): void {
  osascript(`tell application "System Events" to tell process "Simulator"
set frontmost to true
perform action "AXRaise" of window ${quote(title)}
end tell`);
}

interface SimWindow {
  title: string;
  device: string;
}

function listSimWindows(): SimWindow[] {
  const out = osascript(`set out to ""
tell application "System Events"
  repeat with w in windows of process "Simulator"
    set out to out & (name of w) & linefeed
  end repeat
end tell
return out`);
  return out
    .split("\n")
    .filter(Boolean)
    .map((title) => ({ title, device: title.split(" – ")[0]! }))
    .sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }));
}

function positions(count: number): string[] {
  if (count <= 1) return ["center"];
  if (count === 2) return ["left-half", "right-half"];
  if (count === 3) return ["first-third", "center-third", "last-third"];
  if (count === 4) return ["first-fourth", "second-fourth", "third-fourth", "last-fourth"];
  return [
    "top-left-eighth", "top-center-left-eighth", "top-center-right-eighth", "top-right-eighth",
    "bottom-left-eighth", "bottom-center-left-eighth", "bottom-center-right-eighth", "bottom-right-eighth",
  ];
}

export async function organize(): Promise<{ ok: true; placed: { device: string; position: string }[] }> {
  const wins = listSimWindows();
  if (wins.length === 0) throw new Error("no Simulator windows open");
  const pos = positions(wins.length);
  const screens = screenInfo();
  const placed: { device: string; position: string }[] = [];
  for (let i = 0; i < wins.length; i++) {
    const position = pos[i % pos.length]!;
    raise(wins[i]!.title);
    await sleep(250);
    await gatherToMainScreen(wins[i]!.title, screens);
    await place(position);
    placed.push({ device: wins[i]!.device, position });
  }
  return { ok: true, placed };
}
