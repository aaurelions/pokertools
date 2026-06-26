/**
 * Database utilities for E2E test seeding.
 *
 * These functions access the PokerTools API's Prisma client and crypto
 * utilities directly from source. The TypeScript rootDir check is bypassed
 * at type-check time (noEmit = true), and vitest resolves these at runtime.
 */

import crypto from "node:crypto";

// ---- Prisma client (from API generated client) ----
// @ts-ignore - Cross-package source import; resolved by vitest at runtime
import { createPrismaClient } from "../../../api/src/utils/prisma-client.js";

export { createPrismaClient };

// ---- xpub encryption (mirrors packages/api/src/utils/crypto.ts) ----
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

function deriveKey(salt: Buffer, secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, salt, 100000, 32, "sha256");
}

export function encryptXpub(xpub: string, encryptionSecret: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt, encryptionSecret);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(xpub, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([salt, iv, authTag, ciphertext]);
  return combined.toString("base64");
}

export function decryptXpub(encryptedXpub: string, encryptionSecret: string): string {
  const combined = Buffer.from(encryptedXpub, "base64");
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const key = deriveKey(salt, encryptionSecret);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
