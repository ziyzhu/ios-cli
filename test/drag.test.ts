import { describe, expect, test } from "bun:test";
import { dragEvents } from "../src/companion.ts";

type Ev = { press?: { action: { touch?: { point: { x: number; y: number } } }; direction: number }; delay?: { duration: number } };

function touches(evs: Ev[]) {
  return evs
    .filter((e) => e.press?.action.touch)
    .map((e) => ({ ...e.press!.action.touch!.point, direction: e.press!.direction }));
}

function delays(evs: Ev[]) {
  return evs.filter((e) => e.delay).map((e) => e.delay!.duration);
}

describe("dragEvents", () => {
  test("starts with touch down at the start, ends with touch up at the end", () => {
    const evs = dragEvents([{ x: 10, y: 10 }, { x: 110, y: 10 }]);
    const t = touches(evs);
    expect(t[0]).toEqual({ x: 10, y: 10, direction: 0 });
    expect(t[t.length - 1]).toEqual({ x: 110, y: 10, direction: 1 });
    expect(t.slice(0, -1).every((p) => p.direction === 0)).toBe(true);
  });

  test("interpolates moves no farther apart than delta and lands exactly on waypoints", () => {
    const evs = dragEvents([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], { delta: 10 });
    const t = touches(evs);
    for (let i = 1; i < t.length; i++) {
      const step = Math.hypot(t[i]!.x - t[i - 1]!.x, t[i]!.y - t[i - 1]!.y);
      expect(step).toBeLessThanOrEqual(10.001);
    }
    expect(t.some((p) => p.x === 100 && p.y === 0)).toBe(true);
    expect(t[t.length - 1]).toEqual({ x: 100, y: 50, direction: 1 });
  });

  test("inserts press after the down and hold before the up", () => {
    const evs = dragEvents([{ x: 0, y: 0 }, { x: 20, y: 0 }], { press: 0.5, hold: 0.3, delta: 10 });
    expect(evs[0]!.press.action.touch.point).toEqual({ x: 0, y: 0 });
    expect(evs[1]!.delay.duration).toBe(0.5);
    expect(evs[evs.length - 2]!.delay.duration).toBe(0.3);
    expect(evs[evs.length - 1]!.press.direction).toBe(1);
  });

  test("spreads each segment's duration across its move delays", () => {
    const evs = dragEvents([{ x: 0, y: 0 }, { x: 100, y: 0 }], { duration: 0.5, delta: 10 });
    const total = delays(evs).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(0.5, 5);
  });

  test("emits no delays when duration is 0", () => {
    const evs = dragEvents([{ x: 0, y: 0 }, { x: 100, y: 0 }], { duration: 0 });
    expect(delays(evs)).toEqual([]);
  });

  test("requires at least two points", () => {
    expect(() => dragEvents([{ x: 0, y: 0 }])).toThrow("at least two points");
  });
});
