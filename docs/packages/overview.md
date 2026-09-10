# Package Overview

The monorepo is divided into eight npm workspaces. Each package is independently
versioned, built and (where applicable) published to npm.

<div class="pkg-grid">

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/types">@pokertools/types</a></div>
<p>Domain contracts — actions, state, configs, DTOs, Zod schemas.</p>
</div>

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/evaluator">@pokertools/evaluator</a></div>
<p>5/6/7-card evaluation with integer scores — zero dependencies.</p>
</div>

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/engine">@pokertools/engine</a></div>
<p>Immutable Texas Hold'em state machine with strict rules.</p>
</div>

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/sdk">@pokertools/sdk</a></div>
<p>Typed HTTP + WebSocket client and React 19 hooks.</p>
</div>

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/api">@pokertools/api</a></div>
<p>Fastify REST/WS API, Redis table state, BullMQ workers, Prisma.</p>
</div>

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/admin">@pokertools/admin</a></div>
<p>Blockchain sweeps, withdrawals, gas monitoring, Telegram ops.</p>
</div>

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/bench">@pokertools/bench</a></div>
<p>Evaluator, API, worker and socket benchmarks.</p>
</div>

<div class="pkg-card">
<div class="pkg-name"><a href="/pokertools/packages/e2e">@pokertools/e2e</a></div>
<p>Docker + Anvil end-to-end scenarios.</p>
</div>

</div>

## Dependency graph

| Package     | Depends on                           |
| :---------- | :----------------------------------- |
| `types`     | —                                    |
| `evaluator` | —                                    |
| `engine`    | `types`, `evaluator`                 |
| `sdk`       | `types`                              |
| `api`       | `engine`, `types`                    |
| `admin`     | `types` (+ Prisma client from `api`) |
| `bench`     | `evaluator`                          |
| `e2e`       | `sdk`                                |

## Versioning & publishing

| Package                                       | Published to npm                 |
| :-------------------------------------------- | :------------------------------- |
| `@pokertools/types`                           | ✅                               |
| `@pokertools/evaluator`                       | ✅                               |
| `@pokertools/engine`                          | ✅                               |
| `@pokertools/sdk`                             | ✅                               |
| `@pokertools/api` · `admin` · `bench` · `e2e` | Private (docker/deployment only) |

Publishing is automated by the [Publish workflow](https://github.com/aaurelions/pokertools/blob/main/.github/workflows/publish.yml)
on GitHub releases, with npm provenance enabled.

## Test matrix

| Suite                             | Runner  | Count           |
| :-------------------------------- | :------ | :-------------- |
| Engine                            | Jest    | 381             |
| Evaluator                         | Jest    | 94 (+1 skipped) |
| Types                             | Jest    | 150             |
| SDK/React                         | Vitest  | 179             |
| API (incl. DB-backed regressions) | Vitest  | 236             |
| Admin                             | Vitest  | 14              |
| Solidity contracts                | Foundry | 5               |
