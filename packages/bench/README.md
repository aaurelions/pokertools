# 🏎️ @pokertools/bench

> **Performance benchmarks for poker hand evaluators**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A benchmarking tool that compares `@pokertools/evaluator` against other popular poker hand evaluators to validate performance claims.

---

## 📊 Benchmark Results

> **Note:** The results below are illustrative. Actual throughput depends on CPU speed, Node.js version, V8 JIT tier, memory speed, and system load. Run the benchmark on your own hardware for accurate measurements.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      BENCHMARK RESULTS (7-card hands)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  Library                    │  Performance        │  Input Type             │
├─────────────────────────────────────────────────────────────────────────────┤
│  🥇 @pokertools/evaluator   │  ~17M hands/sec     │  Integer codes          │
│  🥈 phe                     │  ~16M hands/sec     │  Integer codes          │
│  🥉 poker-evaluator         │  ~1.3M hands/sec    │  String arrays          │
│  🥉 pokersolver             │  ~70K hands/sec     │  String arrays          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Performance comparison:**

| Library                 | Speed          | vs @pokertools |
| ----------------------- | -------------- | -------------- |
| `@pokertools/evaluator` | 17M hands/sec  | **baseline**   |
| `phe`                   | 16M hands/sec  | ~1x            |
| `poker-evaluator`       | 1.3M hands/sec | ~13x slower    |
| `pokersolver`           | 70K hands/sec  | ~240x slower   |

## 🚀 Running the Benchmark

### From Monorepo Root

```bash
npm run bench
```

### From Package Directory

```bash
cd packages/bench
npm run bench
```

### Available Scripts

| Script           | Command                                                         | Description                                                                          |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `bench`          | `ts-node index.ts`                                              | Standard evaluator comparison benchmark (1,000 hands).                               |
| `bench:detailed` | `ts-node index.ts --detailed`                                   | Same as `bench`; the `--detailed` flag is accepted but not parsed.                   |
| `bench:load`     | `ts-node load.ts`                                               | Short load test against a live API stack (health, queues, optional sockets/actions). |
| `bench:soak`     | `BENCH_DURATION_MS=300000 BENCH_CONCURRENCY=32 ts-node load.ts` | Extended soak test (5 min, 32 concurrent workers).                                   |

### Load/Soak Environment Variables

| Variable              | Default                  | Description                                         |
| --------------------- | ------------------------ | --------------------------------------------------- |
| `POKERTOOLS_API_BASE` | `http://localhost:3000`  | PokerTools API base URL.                            |
| `POKERTOOLS_WS_URL`   | (derived from API_BASE)  | WebSocket endpoint for real-time benchmarks.        |
| `POKERTOOLS_TOKEN`    | —                        | JWT for authenticated WebSocket joins and actions.  |
| `POKERTOOLS_TABLE_ID` | —                        | Table ID for game-action benchmarks.                |
| `REDIS_URL`           | `redis://localhost:6379` | Redis URL for queue-depth benchmarks.               |
| `BENCH_DURATION_MS`   | `30000`                  | Duration of load test in ms (soak default: 300000). |
| `BENCH_CONCURRENCY`   | `16`                     | Number of concurrent workers (soak default: 32).    |

### Sample Output (Evaluator Benchmark)

```
Generating 1000 hands...
🔥 Warming up CPU and JIT...
----------------------------------------------------------------
phe (Int)                 |      16,574,257 hands/sec | ±2.26%
poker-evaluator (Str)     |       1,375,495 hands/sec | ±0.33%
pokersolver (Str)         |          70,980 hands/sec | ±0.70%
@pokertools (Int)         |      17,915,292 hands/sec | ±1.56%
----------------------------------------------------------------
🚀 WINNER: @pokertools (Int)
```

---

## 🔧 How It Works

### Test Setup

1. **Generates 1,000 random 7-card hands**
2. **Warms up CPU and JIT compiler** (5,000 iterations)
3. **Runs each evaluator** on all hands per benchmark cycle
4. **Reports hands/second** with statistical margin of error

### Libraries Compared

| Library                                                            | Type    | Description                                |
| ------------------------------------------------------------------ | ------- | ------------------------------------------ |
| [`@pokertools/evaluator`](../evaluator)                            | Integer | Our evaluator using perfect hash tables    |
| [`phe`](https://www.npmjs.com/package/phe)                         | Integer | Popular integer-based evaluator            |
| [`poker-evaluator`](https://www.npmjs.com/package/poker-evaluator) | String  | Traditional string-based evaluator         |
| [`pokersolver`](https://www.npmjs.com/package/pokersolver)         | String  | Full-featured poker solver with comparison |

---

## 📦 Dependencies

```json
{
  "@pokertools/evaluator": "1.0.11",
  "benchmark": "^2.1.4",
  "bullmq": "^5.79.1",
  "ws": "^8.21.0",
  "phe": "^0.6.0",
  "poker-evaluator": "^2.1.1",
  "pokersolver": "^2.1.4"
}
```

> **Note:** `ts-node` is required to run the benchmark scripts and is provided by the monorepo root `devDependencies`. The package uses `"type": "commonjs"` (CJS) and is not published — it runs from source via `ts-node`.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BENCHMARK FLOW                                      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│  Generate Deck  │  52 cards: ["2s", "3s", ..., "Ac"]
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Shuffle & Deal │  1,000 random 7-card hands
└────────┬────────┘
         │
    ┌────┴────┬────────────────┐
    │         │                │
    ▼         ▼                ▼
┌───────┐ ┌───────┐      ┌───────────┐
│String │ │ Int   │      │  Int PHE  │
│Arrays │ │ Codes │      │  Format   │
└───┬───┘ └───┬───┘      └─────┬─────┘
    │         │                │
    │    ┌────┴────┐           │
    │    │         │           │
    ▼    ▼         ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│poker-eval│ │@pokertools│ │   phe    │
│pokersolvr│ │ evaluator │ │          │
└────┬─────┘ └────┬─────┘ └────┬─────┘
     │            │            │
     └────────────┴────────────┘
                  │
                  ▼
         ┌────────────────┐
         │ Benchmark.js   │
         │ Statistics     │
         └────────────────┘
                  │
                  ▼
         ┌────────────────┐
         │  Results:      │
         │  hands/sec ±%  │
         └────────────────┘
```

---

## 🔬 Methodology

### Why Integer-Based Evaluators Are Faster

```
String-based evaluation:
  "As" → parse rank → parse suit → lookup → evaluate

Integer-based evaluation:
  48 → direct lookup → evaluate

Overhead per card: ~10-20 nanoseconds for parsing
For 7 cards × millions of hands = significant difference
```

### JIT Warm-up

The benchmark includes a warm-up phase to ensure:

- V8 JIT compiler has optimized hot paths
- CPU frequency scaling has reached maximum
- Garbage collection has stabilized

### Statistical Validity

- **Benchmark.js** runs multiple cycles automatically
- **Reports margin of error (±%)** for each measurement
- **Runs until statistically significant** results achieved

---

## 📈 Interpreting Results

### What the Numbers Mean

- **hands/sec**: Number of complete 7-card hand evaluations per second
- **±X%**: Relative margin of error (95% confidence interval)

### Factors Affecting Performance

| Factor          | Impact                      |
| --------------- | --------------------------- |
| CPU Speed       | Linear correlation          |
| Node.js Version | V8 optimizations vary       |
| Memory Speed    | Affects lookup table access |
| Other Processes | Can cause variance          |

### Fair Comparison Notes

1. **Integer vs String**: Integer-based evaluators have an inherent advantage due to no parsing overhead
2. **Feature Set**: `pokersolver` offers more features (hand comparison, wildcards) which adds overhead
3. **Memory Usage**: Lookup table evaluators trade memory for speed

---

## 🔗 Related Packages

| Package                               | Description                     |
| ------------------------------------- | ------------------------------- |
| [@pokertools/evaluator](../evaluator) | The evaluator being benchmarked |
| [@pokertools/engine](../engine)       | Uses the evaluator for showdown |

---

## 📈 API, Worker, and Socket Load/Soak Benchmarks

Run short load checks against a live PokerTools stack:

```bash
# From the monorepo root:
POKERTOOLS_API_BASE=http://localhost:3000 npm run bench:load -w @pokertools/bench
```

To include authenticated WebSocket joins and game actions, provide a JWT and table ID:

```bash
POKERTOOLS_TOKEN=<jwt> POKERTOOLS_TABLE_ID=<table-id> \
  npm run bench:load -w @pokertools/bench
```

Longer soak profile (5 minutes, 32 workers):

```bash
npm run bench:soak -w @pokertools/bench
```

Results are emitted as CSV (`name,count,ok,failed,p50_ms,p95_ms,max_ms`) for CI ingestion.

---

## 📄 License

MIT © A.Aurelius
