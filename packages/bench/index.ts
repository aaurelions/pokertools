// @ts-ignore
import Benchmark from "benchmark";
// @ts-ignore
import * as PheOriginal from "phe";
// @ts-ignore
import * as PokerEvaluator from "poker-evaluator";
// @ts-ignore
import { Hand } from "pokersolver";

import { evaluate, getCardCode } from "@pokertools/evaluator";

/*
~# npm run bench
🃏 Starting Benchmark: 1000 random 7-card hands per cycle
----------------------------------------------------------------
phe (Int)                 |      16,574,257 hands/sec | ±2.26%
poker-evaluator (Str)     |       1,375,495 hands/sec | ±0.33%
pokersolver (Str)         |          70,980 hands/sec | ±0.70%
@pokertools (Int)         |      17,915,292 hands/sec | ±1.56%
----------------------------------------------------------------
🚀 WINNER: @pokertools (Int)
*/

const suite = new Benchmark.Suite();

// --- Data Setup ---
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

// Generate 1000 random 7-card hands
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
  // PHE uses the exact same integer format, but let's map it explicitly to be safe
  handsIntPhe.push(hand7.map((c: string) => PheOriginal.cardCode(c[0], c[1])));
}

// --- WARM UP PHASE ---
// This forces V8 to optimize functions and CPU to boost clock speed
console.log("🔥 Warming up CPU and JIT...");
for (let i = 0; i < 5000; i++) {
  const h = handsInt[i % HANDS_COUNT];
  evaluate(h); // Warm up ours
  PheOriginal.evaluateCardCodes(h); // Warm up theirs
}
console.log("----------------------------------------------------------------");

// --- Test Cases ---

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
  // --- Results Reporter ---
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
