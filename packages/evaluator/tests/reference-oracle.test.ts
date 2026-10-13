import { evaluateStrings } from "../src";

const RANKS = "23456789TJQKA";
const SUITS = "shdc";
const DECK = [...RANKS].flatMap((r) => [...SUITS].map((s) => r + s));

/** Independent naive 5-card scorer: returns comparable tuple (higher = better). */
function score5(cards: string[]): number[] {
  const v = cards.map((c) => RANKS.indexOf(c[0]!) + 2).sort((a, b) => b - a);
  const flush = new Set(cards.map((c) => c[1])).size === 1;
  const counts = new Map<number, number>();
  v.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let straightHigh = 0;
  const uniq = [...new Set(v)];
  if (uniq.length === 5) {
    const span = uniq[0]! - uniq[4]!;
    if (span === 4) straightHigh = uniq[0]!;
    else if (uniq.join() === "14,5,4,3,2") straightHigh = 5;
  }
  const kick = groups.map((g) => g[0]);
  const shape = groups.map((g) => g[1]).join("");
  if (straightHigh && flush) return [8, straightHigh];
  if (shape === "41") return [7, ...kick];
  if (shape === "32") return [6, ...kick];
  if (flush) return [5, ...v];
  if (straightHigh) return [4, straightHigh];
  if (shape === "311") return [3, ...kick];
  if (shape === "221") return [2, ...kick];
  if (shape === "2111") return [1, ...kick];
  return [0, ...v];
}
function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
function best7(cards: string[]): number[] {
  let top: number[] = [-1];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++) {
      const s = score5(cards.filter((_, i) => i !== a && i !== b));
      if (cmp(s, top) > 0) top = s;
    }
  return top;
}

let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
function draw(n: number): string[] {
  const d = [...DECK];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d.slice(0, n);
}

describe("evaluator vs independent oracle", () => {
  test("wheel and steel wheel", () => {
    const wheel = evaluateStrings(["As", "2d", "3c", "4h", "5s", "Kd", "Qc"]);
    const six = evaluateStrings(["6s", "2d", "3c", "4h", "5s", "Kd", "Qc"]);
    expect(six).toBeLessThan(wheel);
    const steel = evaluateStrings(["Ah", "2h", "3h", "4h", "5h", "Ad", "Ac"]);
    const quads = evaluateStrings(["Ah", "Ad", "Ac", "As", "5h", "2d", "3c"]);
    const sixHighSF = evaluateStrings(["2h", "3h", "4h", "5h", "6h", "Ad", "Ac"]);
    expect(steel).toBeLessThan(quads);
    expect(sixHighSF).toBeLessThan(steel);
  });

  test("pairwise ordering agrees with oracle on random 7-card hands", () => {
    for (let i = 0; i < 4000; i++) {
      const d = draw(14);
      const h1 = d.slice(0, 7);
      const h2 = d.slice(7);
      // shared board variation: force sharing board half the time
      if (i % 2) h2.splice(0, 5, ...h1.slice(0, 5));
      const e = Math.sign(evaluateStrings(h2) - evaluateStrings(h1)); // + => h1 better
      const o = Math.sign(cmp(best7(h1), best7(h2)));
      expect(e).toBe(o);
    }
  });

  test("6 and 5 card agree with oracle", () => {
    for (let i = 0; i < 1500; i++) {
      const d = draw(10);
      const a = d.slice(0, 5),
        b = d.slice(5);
      expect(Math.sign(evaluateStrings(b) - evaluateStrings(a))).toBe(
        Math.sign(cmp(score5(a), score5(b)))
      );
    }
  });
});
