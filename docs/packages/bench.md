# @pokertools/bench

Benchmark suites for the evaluator plus load/soak scripts for the API, workers and sockets.

## Usage

```bash
npm run bench                          # full suite (requires API + Redis for API benches)
npm run bench -w @pokertools/bench -- evaluator   # evaluator benchmarks only
```

Benchmark output is `benchmark.js`-style table: ops/sec, margin of error and the
slowest/fastest ratio per suite.

### Prerequisites

| Suite     | Needs API running | Needs Redis |
| :-------- | :---------------- | :---------- |
| Evaluator | ❌                | ❌          |
| API       | ✅                | ✅          |
| Workers   | ❌                | ✅          |
| Socket    | ✅                | ✅          |

Start the stack with `npm run dev:api` + `npm run dev:workers` (or the Docker stack,
see [Deployment](/deployment)).

## What is benchmarked

| Suite     | Measures                                                            |
| :-------- | :------------------------------------------------------------------ |
| Evaluator | 5/6/7-card evaluation throughput (hands/sec), string vs integer API |
| API       | Request latency/throughput against Fastify routes                   |
| Workers   | BullMQ queue throughput (settle, archive, deal)                     |
| Socket    | WebSocket session churn and state-update fan-out                    |

## Evaluator comparison

The evaluator suite compares `@pokertools/evaluator` against popular JS libraries
(`phe`, `poker-evaluator`, `pokersolver`):

| Implementation                        | Approx. throughput                        |
| :------------------------------------ | :---------------------------------------- |
| `@pokertools/evaluator` (integer API) | millions of hands/sec                     |
| `phe`                                 | fast C-style tables, lower than evaluator |
| `poker-evaluator`                     | moderate                                  |
| `pokersolver`                         | slowest (high-level string API)           |

::: tip
Published throughput figures are illustrative of the local machine — run the suite on
your own hardware for numbers you can rely on.
:::

## Writing a new benchmark

```ts
import Benchmark from "benchmark";
import { evaluateStrings } from "@pokertools/evaluator";

const hand = ["As", "Ks", "Qs", "Js", "Ts"];

new Benchmark("evaluate royal flush", {
  fn: () => evaluateStrings(hand),
  onComplete: (event: any) => console.log(String(event.target)),
}).run();
```

## Load & soak scripts

- `api/*` — sustained request load against a running API instance
- `workers/*` — queue saturation tests
- `socket/*` — connection churn and fan-out soak

These require the API (and Redis) to be running — see the [API docs](/packages/api).
