// @ts-ignore - no type defs for "benchmark"
import Benchmark from "benchmark";
import * as PheOriginal from "phe";
import * as PokerEvaluator from "poker-evaluator";
import { Hand } from "pokersolver";

import { evaluate, getCardCode } from "@pokertools/evaluator";

const suite = new Benchmark.Suite();
const SUITS = ["s", "c", "h", "d"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

function createDeck() {
  const deck: string[] = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(r + s);
    }
  }
  return deck;
}

function shuffle(array: any[]) {
  let m = array.length,
    t,
    i;
  while (m) {
    i = Math.floor(Math.random() * m--);
    t = array[m];
    array[m] = array[i];
    array[i] = t;
  }
  return array;
}

// 1000 random 7-card hands
const HANDS_COUNT = 1000;
const handsStr: string[][] = [];
const handsInt: number[][] = [];
const handsIntPhe: number[][] = [];

console.log(`Generating ${HANDS_COUNT} hands...`);
for (let i = 0; i < HANDS_COUNT; i++) {
  const deck = shuffle(createDeck());
  const hand7 = deck.slice(0, 7);

  handsStr.push(hand7);
  handsInt.push(hand7.map((c: string) => getCardCode(c)));
  handsIntPhe.push(hand7.map((c: string) => PheOriginal.cardCode(c[0], c[1])));
}

// Warm up V8 JIT before benchmarking
console.log("🔥 Warming up CPU and JIT...");
for (let i = 0; i < 5000; i++) {
  const h = handsInt[i % HANDS_COUNT];
  evaluate(h);
  PheOriginal.evaluateCardCodes(h);
}
console.log("----------------------------------------------------------------");

suite
  .add("phe (Int)", () => {
    for (let i = 0; i < HANDS_COUNT; i++) {
      PheOriginal.evaluateCardCodes(handsIntPhe[i]);
    }
  })
  .add("poker-evaluator (Str)", () => {
    for (let i = 0; i < HANDS_COUNT; i++) {
      PokerEvaluator.evalHand(handsStr[i]);
    }
  })
  .add("pokersolver (Str)", () => {
    for (let i = 0; i < HANDS_COUNT; i++) {
      Hand.solve(handsStr[i]);
    }
  })
  .add("@pokertools (Int)", () => {
    for (let i = 0; i < HANDS_COUNT; i++) {
      evaluate(handsInt[i]);
    }
  })
  .on("cycle", (event: any) => {
    const benchmark = event.target;
    const handsPerSec = Math.floor(benchmark.hz * HANDS_COUNT).toLocaleString();
    const rme = benchmark.stats.rme.toFixed(2);

    console.log(`${benchmark.name.padEnd(25)} | ${handsPerSec.padStart(15)} hands/sec | ±${rme}%`);
  })
  .on("complete", function (this: any) {
    console.log("----------------------------------------------------------------");
    const fastest = this.filter("fastest").map("name");
    console.log(`🚀 WINNER: ${fastest}\n`);
  })
  .run({ async: true });
