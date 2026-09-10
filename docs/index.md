---
layout: home
hero:
  name: PokerTools
  text: Texas Hold'em infrastructure that ships
  tagline: Immutable engine, 17M+ hand/sec evaluator, typed SDK, scalable API and on-chain settlement — one npm monorepo.
  image:
    src: /favicon.svg
    alt: PokerTools
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Package Overview
      link: /packages/overview
    - theme: alt
      text: GitHub
      link: https://github.com/aaurelions/pokertools
features:
  - icon: 🃏
    title: Immutable Poker Engine
    details: Redux-style state machine with strict validation, side pots, rake, tournaments, time banks and TDA-compliant raise rules.
    link: /packages/engine
  - icon: ⚡
    title: High-Performance Evaluator
    details: Precomputed-table 5/6/7-card evaluation in integer score space — over 17 million hands per second.
    link: /packages/evaluator
  - icon: 📚
    title: Shared Types
    details: Single source of truth for actions, state, pots, configs and API DTOs, validated end-to-end with Zod schemas.
    link: /packages/types
  - icon: 🔌
    title: TypeScript SDK
    details: Typed HTTP client, WebSocket state sync and React 19 hooks with idempotent retries and token-aware reconnects.
    link: /packages/sdk
  - icon: 🚀
    title: Scalable API
    details: Fastify REST + WebSocket, Redis-backed table state, BullMQ workers and Prisma persistence (SQLite or PostgreSQL).
    link: /packages/api
  - icon: 🛡️
    title: Blockchain Admin
    details: HD wallets, ERC-2612 permit sweeps, withdrawal broadcasting, gas monitoring and Telegram approvals.
    link: /packages/admin
---

## Why PokerTools

Everything a real-money poker platform needs, in one versioned monorepo — from the
==pure game logic== to the blockchain settlement layer:

| Capability              | Highlights                                                                                                            |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **Rules correctness**   | TDA-43/47 raise rules, side pots, odd-chip distribution, rake caps, tournament blind structures, time banks           |
| **Security**            | Masked public views (no hole cards, deck _or_ undo history), SIWE auth, claim-once refunds, `onlyOwner` permit sweeps |
| **Financial integrity** | Double-entry ledger, balanced settlement batches, tournament escrow, idempotent workers                               |
| **Performance**         | Integer lookup-table evaluator: **~17M hands/sec**, zero-allocation hot path                                          |
| **Deployment**          | Docker Compose, GitHub Actions, GitHub Pages docs, npm provenance publishing                                          |

## Quick start

::: code-group

```bash [Install the monorepo]
git clone https://github.com/aaurelions/pokertools.git
cd pokertools
npm install
npm run build
npm test                        # 1 059 tests + 5 contract tests
```

```ts [Score a hand]
import { evaluateStrings, getHandRank, HandRank } from "@pokertools/evaluator";

const board = ["Ts", "Jc", "Qd", "2h", "9s"];
const hero = ["As", "Kh"];

const rank = getHandRank(evaluateStrings([...board, ...hero]));
console.log(HandRank[rank]); // "Straight"
```

```ts [Run a hand]
import { PokerEngine } from "@pokertools/engine";
import { ActionType } from "@pokertools/types";

const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 3 });
[0, 1, 2].forEach((seat) => engine.sit(seat, `p${seat}`, `Player ${seat}`, 1000));
engine.deal();

engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 60 });
engine.act({ type: ActionType.CALL, playerId: "p1" });
engine.act({ type: ActionType.FOLD, playerId: "p2" });
console.log(engine.state.street); // "FLOP"
```

```ts [Call the API]
import { PokerClient } from "@pokertools/sdk";

const client = new PokerClient({ baseUrl: "https://api.example.com" });
const tables = await client.getTables();
console.log(tables);
```

:::

::: tip Full examples
Every example above is expanded with tables and API references on its package page:
[engine](/packages/engine) · [evaluator](/packages/evaluator) · [sdk](/packages/sdk) · [api](/packages/api).
:::

## Packages

| Package                                      | Description                                       | Published |
| :------------------------------------------- | :------------------------------------------------ | :-------- |
| [@pokertools/types](/packages/types)         | Domain contracts, actions, DTOs, Zod schemas      | ✅ npm    |
| [@pokertools/evaluator](/packages/evaluator) | 5/6/7-card evaluation — integer scores, zero deps | ✅ npm    |
| [@pokertools/engine](/packages/engine)       | Immutable Texas Hold'em state machine             | ✅ npm    |
| [@pokertools/sdk](/packages/sdk)             | HTTP + WebSocket client and React 19 hooks        | ✅ npm    |
| [@pokertools/api](/packages/api)             | Fastify REST/WS API, Redis state, BullMQ, Prisma  | 🐳 Docker |
| [@pokertools/admin](/packages/admin)         | Blockchain sweeps, withdrawals, gas, Telegram ops | 🐳 Docker |
| [@pokertools/bench](/packages/bench)         | Evaluator/API/worker/socket benchmarks            | local     |
| [@pokertools/e2e](/packages/e2e)             | Docker + Anvil end-to-end scenarios               | local     |

## Explore the docs

| Section                                   | What you'll find                                              |
| :---------------------------------------- | :------------------------------------------------------------ |
| [Getting Started](/guide/getting-started) | Requirements, install, scripts, first steps per package       |
| [Architecture](/guide/architecture)       | Component map, hand lifecycle, concurrency model, security    |
| [Deployment](/deployment)                 | Docker production, GitHub Actions, backups, release checklist |
| [Engine Review](/ENGINE_REVIEW)           | 2026 correctness review with regression coverage              |

## Project stats

| Metric               | Value                        |
| :------------------- | :--------------------------- |
| Workspaces           | 8 npm packages               |
| Tests                | 1 059 passing (+ 5 Solidity) |
| Evaluator throughput | ~17M hands/sec               |
| Language             | TypeScript 6.0, Solidity 0.8 |
| License              | MIT                          |
