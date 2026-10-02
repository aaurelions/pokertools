/**
 * Database utility for E2E test seeding.
 *
 * The canonical finance flow is key-free: no derived deposit addresses, no
 * encrypted xpriv/xpub. Tests only need the API's own Prisma client factory.
 * The TypeScript rootDir check is bypassed at type-check time (noEmit = true),
 * and vitest resolves this at runtime.
 */

// @ts-ignore - Cross-package source import; resolved by vitest at runtime
import { createPrismaClient } from "../../../api/src/utils/prisma-client.js";

export { createPrismaClient };
