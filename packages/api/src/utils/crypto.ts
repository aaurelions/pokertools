import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Encryption utilities for sensitive data at rest
 *
 * Uses AES-256-GCM for authenticated encryption
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits

/**
 * Derives a 256-bit encryption key from the master secret
 */
function deriveKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    config.JWT_SECRET, // Use JWT_SECRET as master key for now
    salt,
    100000, // iterations
    32, // key length (256 bits)
    "sha256"
  );
}

/**
 * Encrypts data using AES-256-GCM
 *
 * Format: salt (32) || iv (16) || authTag (16) || ciphertext
 * All returned as base64 string
 */
export function encrypt(plaintext: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine: salt || iv || authTag || ciphertext
  const combined = Buffer.concat([salt, iv, authTag, ciphertext]);
  const result = combined.toString("base64");
  return result;
}

/**
 * Decrypts data encrypted with encrypt()
 */
export function decrypt(encryptedData: string): string {
  const combined = Buffer.from(encryptedData, "base64");

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);

  if (iv.length !== IV_LENGTH) {
    console.error(
      `[Crypto Debug] IV Length Mismatch. Expected: ${IV_LENGTH}, Got: ${iv.length}. Total Buffer: ${combined.length}`
    );
  }

  const authTag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Encrypts xpub for database storage
 */
export function encryptXpub(xpub: string): string {
  return encrypt(xpub);
}

/**
 * Decrypts xpub from database
 */
export function decryptXpub(encryptedXpub: string): string {
  return decrypt(encryptedXpub);
}
