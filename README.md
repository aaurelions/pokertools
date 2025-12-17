# PokerTools Monorepo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml/badge.svg)](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml)

**PokerTools** is an enterprise-grade platform for building, deploying, and managing real-time Texas Hold'em poker applications. This monorepo contains the complete ecosystem, from the core game engine and hand evaluator to a full-featured API, Admin dashboard service, and client-side SDK.

## 🏗️ Architecture

The repository is organized into workspaces managed by NPM.

| Package                                           | Description                                                              | Version |
| :------------------------------------------------ | :----------------------------------------------------------------------- | :------ |
| **[@pokertools/engine](./packages/engine)**       | The immutable core logic for Texas Hold'em state management.             | `1.0.2` |
| **[@pokertools/evaluator](./packages/evaluator)** | High-performance hand evaluation and win frequency calculation.          | `1.0.2` |
| **[@pokertools/api](./packages/api)**             | Scalable REST & WebSocket API built with Fastify, Redis, and PostgreSQL. | `1.0.2` |
| **[@pokertools/sdk](./packages/sdk)**             | TypeScript SDK with React hooks and real-time socket management.         | `1.0.2` |
| **[@pokertools/admin](./packages/admin)**         | Financial sweeper service, withdrawal processing, and Telegram bot.      | `1.0.2` |
| **[@pokertools/types](./packages/types)**         | Shared TypeScript definitions, Zod schemas, and DTOs.                    | `1.0.2` |
| **[@pokertools/bench](./packages/bench)**         | Performance benchmarking suite for the engine and evaluator.             | `1.0.2` |

## ✨ Key Features

- **Robust Game Engine**: Handles complex side pots, all-in scenarios, and exact rake calculations. Verified with property-based testing.
- **High Performance**: Evaluator can process millions of hands per second.
- **Scalable Infrastructure**: API designed for horizontal scaling with Redis Pub/Sub and atomic database transactions.
- **Financial Integrity**: Double-entry ledger system for all chip movements.
- **Blockchain Integration**: Built-in support for crypto deposits and withdrawals (USDC/ETH) with automatic sweeping (admin service).
- **Developer Experience**: Fully typed SDK for rapid frontend development.

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v20+
- **NPM**: v10+
- **Docker** (optional, for running Redis/Postgres locally)

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

### Development Workflow

The monorepo provides root-level scripts to manage the lifecycle of all packages.

- **Start API (Dev Mode):**
  ```bash
  npm run dev:api
  ```
- **Run All Tests:**
  ```bash
  npm test
  ```
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

See individual package READMEs for specific configuration details.

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on how to submit pull requests, report issues, and setup your development environment.

## 🔒 Security

Security is a top priority.

- **Financials**: All transfers are atomic and recorded in a ledger.
- **Game Integrity**: The engine is tested against millions of random scenarios.
- **Vulnerabilities**: Please report security issues via [SECURITY.md](./SECURITY.md).

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
