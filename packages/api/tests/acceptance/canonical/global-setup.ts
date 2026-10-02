/**
 * Global setup for the canonical acceptance suite.
 *
 * Provisions PostgreSQL + Redis once for the whole run and tears them down
 * afterwards. The app under test must connect to these, never to a developer
 * database or Redis instance.
 */

import { provisionAcceptanceEnv, teardownAcceptanceEnv, type AcceptanceEnv } from "./infra.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const env: AcceptanceEnv = await provisionAcceptanceEnv();
  console.log(`[canonical-acceptance] PostgreSQL: ${env.databaseUrl}`);
  console.log(`[canonical-acceptance] Redis: ${env.redisUrl}`);
  return async () => {
    await teardownAcceptanceEnv(env);
  };
}
