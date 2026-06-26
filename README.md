# PokerTools Monorepo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml/badge.svg)](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml)

**PokerTools** is an enterprise-grade platform for building, deploying, and managing real-time Texas Hold'em poker applications. This monorepo contains the complete ecosystem, from the core game engine and hand evaluator to a full-featured API, Admin dashboard service, and client-side SDK.

## 🏗️ Architecture

The repository is organized into workspaces managed by NPM.

| Package                                           | Description                                                                                                 | Version  |
| :------------------------------------------------ | :---------------------------------------------------------------------------------------------------------- | :------- |
| **[@pokertools/engine](./packages/engine)**       | The immutable core logic for Texas Hold'em state management.                                                | `1.0.10` |
| **[@pokertools/evaluator](./packages/evaluator)** | High-performance hand evaluation and win frequency calculation.                                             | `1.0.10` |
| **[@pokertools/api](./packages/api)**             | Scalable REST & WebSocket API built with Fastify, Redis, and Prisma (SQLite default, PostgreSQL supported). | `1.0.10` |
| **[@pokertools/sdk](./packages/sdk)**             | TypeScript SDK with React hooks and real-time socket management.                                            | `1.0.10` |
| **[@pokertools/admin](./packages/admin)**         | Financial sweeper service, withdrawal processing, and Telegram bot.                                         | `1.0.10` |
| **[@pokertools/types](./packages/types)**         | Shared TypeScript definitions, Zod schemas, and DTOs.                                                       | `1.0.10` |
| **[@pokertools/bench](./packages/bench)**         | Performance benchmarking suite for evaluator, API, workers, sockets, and game actions.                      | `1.0.10` |
| **[@pokertools/e2e](./packages/e2e)**             | Docker-based end-to-end integration tests exercising the full API, SDK, WebSocket, and blockchain stack.    | `1.0.10` |

## ✨ Key Features

- **Robust Game Engine**: Handles complex side pots, all-in scenarios, and exact rake calculations. Verified with property-based testing.
- **High Performance**: Evaluator can process millions of hands per second.
- **Scalable Infrastructure**: API designed for horizontal scaling with Redis Pub/Sub and atomic database transactions.
- **Financial Integrity**: Double-entry ledger system for all chip movements.
- **Blockchain Integration**: Built-in support for crypto deposits and withdrawals (USDC/ETH) with automatic sweeping (admin service).
- **Developer Experience**: Fully typed SDK for rapid frontend development.

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v24+
- **NPM**: v10+
- **Docker** (optional, for running the full stack locally via `docker compose up --build`)
- **Foundry** (optional, for running E2E blockchain tests via `npm run e2e:docker`)

### Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/aaurelions/pokertools.git
    cd pokertools
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Build all packages:**
    ```bash
    npm run build
    ```

### Docker Quick Start

The fastest way to get started is with Docker Compose:

```bash
docker compose up --build
```

This starts the API on `http://localhost:3000` with a Redis service and a persistent SQLite database volume. In production always replace the dev-only fallback `JWT_SECRET`, `COOKIE_SECRET`, and `WALLET_ENCRYPTION_SECRET` with strong values.

To use the pre-built image from GitHub Container Registry:

```bash
docker pull ghcr.io/aaurelions/pokertools
```

GHCR images are published automatically on each [GitHub release](https://github.com/aaurelions/pokertools/releases), tagged as `latest`, `1`, `1.0`, `1.0.10`, and a full commit SHA for every release-triggered build. See [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) for details.

### Development Workflow

The monorepo provides root-level scripts to manage the lifecycle of all packages.

- **Start API (Dev Mode):**
  ```bash
  npm run dev:api
  ```
- **Start Background Workers:**
  ```bash
  npm run dev:workers
  ```
- **Run All Tests:**
  ```bash
  npm test
  ```
- **Run Docker E2E Tests:**

  ```bash
  npm run e2e:docker
  ```

  Starts a local Anvil chain, deploys contracts, builds the API Docker image, and runs the full integration test suite (auth, deposits, game lifecycle, withdrawals). Requires Docker and Foundry.

- **Run Benchmarks:**
  ```bash
  npm run bench
  ```
- **Typecheck Entire Repo:**
  ```bash
  npm run typecheck
  ```
- **Format Code:**
  ```bash
  npm run format
  ```

## 🛠️ Configuration

Most packages rely on environment variables. Copy the example files in each package to get started:

```bash
cp packages/api/.env.example packages/api/.env
cp packages/admin/.env.example packages/admin/.env
```

### Endpoints

| Endpoint        | Description                                            |
| :-------------- | :----------------------------------------------------- |
| `GET  /health`  | Dependency health check for API, DB, Redis, and queues |
| `GET  /metrics` | Prometheus-compatible operational metrics              |
| `GET  /docs`    | Swagger UI (Fastify `@fastify/swagger-ui`)             |

### Security-Sensitive Environment Variables

| Variable                   | Purpose                                   |
| :------------------------- | :---------------------------------------- |
| `JWT_SECRET`               | Signs JWT access tokens                   |
| `COOKIE_SECRET`            | Signs httpOnly session cookies            |
| `WALLET_ENCRYPTION_SECRET` | Encrypts/decrypts HD wallet xpub material |

These are loaded at startup via `envalid` and must be set to strong, unique values in production. The Docker Compose file provides dev-only fallback defaults — never use those fallbacks outside of local development.

See individual package READMEs for additional configuration details.

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on how to submit pull requests, report issues, and setup your development environment.

## 🔒 Security

Security is a top priority.

- **Financials**: All transfers are atomic and recorded in a ledger.
- **Game Integrity**: The engine is tested against millions of random scenarios.
- **Vulnerabilities**: Please report security issues via [SECURITY.md](./SECURITY.md).

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
