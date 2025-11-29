# 🃏 Poker Evaluator Benchmarks

This repository measures the performance of the most popular JavaScript/TypeScript poker hand evaluators.

The goal is to determine how many **7-card hands (River)** each library can evaluate per second. This is the most computationally expensive scenario in Texas Hold'em and is critical for Equity Calculators and AI solvers.

## 🚀 Results

Tests run on Node.js V8 Engine.
**Higher is better.**

| Library                   | Input Type  | Speed (Hands/Sec) | Relative Speed |
| :------------------------ | :---------- | :---------------- | :------------- |
| **@pokertools/evaluator** | **Integer** | **~17,900,000**   | **100%**       |
| phe                       | Integer     | ~16,550,000       | 92.5%          |
| poker-evaluator           | String      | ~1,390,000        | 7.7%           |
| pokersolver               | String      | ~73,000           | 0.4%           |

### Raw Output

```text
🃏 Starting Benchmark: 1000 random 7-card hands per cycle
----------------------------------------------------------------
phe (Int)                 |      16,574,257 hands/sec | ±2.26%
poker-evaluator (Str)     |       1,375,495 hands/sec | ±0.33%
pokersolver (Str)         |          70,980 hands/sec | ±0.70%
@pokertools (Int)         |      17,915,292 hands/sec | ±1.56%
----------------------------------------------------------------
🚀 WINNER: @pokertools (Int)
```

## 💡 Analysis

### 1. The "String Tax"

Libraries that accept strings (e.g., `'Ah'`, `'Ks'`) are significantly slower because they spend CPU cycles parsing text before calculating value.

- **@pokertools** and **phe** use integers internally. By converting cards to integers _once_ at the start of a game, you achieve **12x performance** over string-based libraries.

### 2. Memory Optimization

**@pokertools** beats **phe** slightly because of memory management.

- **phe** (the original library) allocates new arrays inside the evaluation function, triggering the Garbage Collector frequently.
- **@pokertools** uses static memory buffers, preventing GC overhead during tight simulation loops.

### 3. Algorithm Differences

- **@pokertools / phe:** Use a Perfect Hash algorithm (Cactus Kev variant). It is pure math and bitwise operations. Extremely fast.
- **poker-evaluator:** Uses a large lookup table (Two-Plus-Two algorithm). While fast in C++, accessing large memory arrays in JavaScript can cause CPU cache misses.
- **pokersolver:** Designed for logic and human-readable descriptions (e.g., "Full House, Kings full of Tens"). It creates complex objects, making it too slow for Monte Carlo simulations, but excellent for UI display.

## 🛠️ Methodology

1.  **Setup:** We generate 1,000 random 7-card hands.
2.  **Warm-up:** We run the evaluator 5,000 times before measuring. This forces the V8 engine to JIT-compile the code and signals the CPU to ramp up clock speed.
3.  **Measurement:** We use `benchmark.js` to run the suite until statistically significant results are found.
4.  **Fairness:**
    - For Integer libraries, inputs are pre-converted to integers (measuring raw calc speed).
    - For String libraries, inputs are passed as strings (measuring parsing + calc speed, as intended by those libs).

## 📦 How to Run

1.  Install dependencies:

    ```bash
    npm install
    ```

2.  Run the benchmark:
    ```bash
    npm run bench
    ```
