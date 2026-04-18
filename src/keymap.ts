// USB HID usage codes for US keyboard. Mirrors idb/common/hid.py KEY_MAP.

const plain: Record<string, number> = {
  a: 4, b: 5, c: 6, d: 7, e: 8, f: 9, g: 10, h: 11, i: 12, j: 13, k: 14, l: 15, m: 16,
  n: 17, o: 18, p: 19, q: 20, r: 21, s: 22, t: 23, u: 24, v: 25, w: 26, x: 27, y: 28, z: 29,
  "1": 30, "2": 31, "3": 32, "4": 33, "5": 34, "6": 35, "7": 36, "8": 37, "9": 38, "0": 39,
  "\n": 40, ";": 51, "=": 46, ",": 54, "-": 45, ".": 55, "/": 56, "`": 53, "[": 47, "\\": 49,
  "]": 48, "'": 52, " ": 44,
};
const shifted: Record<string, number> = {
  A: 4, B: 5, C: 6, D: 7, E: 8, F: 9, G: 10, H: 11, I: 12, J: 13, K: 14, L: 15, M: 16,
  N: 17, O: 18, P: 19, Q: 20, R: 21, S: 22, T: 23, U: 24, V: 25, W: 26, X: 27, Y: 28, Z: 29,
  "!": 30, "@": 31, "#": 32, $: 33, "%": 34, "^": 35, "&": 36, "*": 37, "(": 38, ")": 39,
  _: 45, "+": 46, "{": 47, "}": 48, ":": 51, '"': 52, "|": 49, "<": 54, ">": 55, "?": 56, "~": 53,
};
const SHIFT = 225;

export type KeyEvent = { keycode: number; down: boolean };

export function textToKeyEvents(text: string): KeyEvent[] {
  const out: KeyEvent[] = [];
  for (const ch of text) {
    if (ch in plain) {
      const k = plain[ch]!;
      out.push({ keycode: k, down: true }, { keycode: k, down: false });
    } else if (ch in shifted) {
      const k = shifted[ch]!;
      out.push(
        { keycode: SHIFT, down: true },
        { keycode: k, down: true },
        { keycode: k, down: false },
        { keycode: SHIFT, down: false },
      );
    } else {
      throw new Error(`No keycode for character: ${JSON.stringify(ch)}`);
    }
  }
  return out;
}
