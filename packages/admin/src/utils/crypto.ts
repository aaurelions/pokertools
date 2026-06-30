import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Encryption utilities for sensitive data at rest
 *
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Split-secret architecture:
 * - WALLET_ENCRYPTION_SECRET encrypts xpub material (public keys only)
 * - WALLET_XPRIV_ENCRYPTION_SECRET encrypts xpriv material (private keys)
 *
 * The admin service uses WALLET_XPRIV_ENCRYPTION_SECRET for decrypting xprivs
 * from the AdminWallet table (written at setup time by the admin).
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits

/**
 * Derives a 256-bit encryption key from the given secret
 */
function deriveKey(salt: Buffer, secret: string): Buffer {
  return crypto.pbkdf2Sync(
    secret,
    salt,
    100000, // iterations
    32, // key length (256 bits)
    "sha256"
  );
}

/**
 * Encrypts data using AES-256-GCM with the given secret
 *
 * Format: salt (32) || iv (16) || authTag (16) || ciphertext
 * All returned as base64 string
 */
export function encryptWithSecret(plaintext: string, secret: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt, secret);
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
 * Decrypts data encrypted with encryptWithSecret()
 */
export function decryptWithSecret(encryptedData: string, secret: string): string {
  const combined = Buffer.from(encryptedData, "base64");

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);

  const authTag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt, secret);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Encrypts data using AES-256-GCM (legacy wrapper)
 *
 * @deprecated Use encryptWithSecret with explicit secret for new code
 */
export function encrypt(plaintext: string): string {
  return encryptWithSecret(plaintext, config.WALLET_ENCRYPTION_SECRET);
}

/**
 * Decrypts data encrypted with encrypt() (legacy wrapper)
 *
 * @deprecated Use decryptWithSecret with explicit secret for new code
 */
export function decrypt(encryptedData: string): string {
  return decryptWithSecret(encryptedData, config.WALLET_ENCRYPTION_SECRET);
}

/**
 * Encrypts xpub for database storage (public key material)
 */
export function encryptXpub(xpub: string): string {
  return encryptWithSecret(xpub, config.WALLET_ENCRYPTION_SECRET);
}

/**
 * Decrypts xpub from database (public key material)
 */
export function decryptXpub(encryptedXpub: string): string {
  return decryptWithSecret(encryptedXpub, config.WALLET_ENCRYPTION_SECRET);
}

/**
 * Encrypts xpriv for database storage (Admin-side, private key)
 * Uses WALLET_XPRIV_ENCRYPTION_SECRET for defense-in-depth
 */
export function encryptXpriv(xpriv: string): string {
  if (!config.WALLET_XPRIV_ENCRYPTION_SECRET) {
    throw new Error("WALLET_XPRIV_ENCRYPTION_SECRET is not configured");
  }
  return encryptWithSecret(xpriv, config.WALLET_XPRIV_ENCRYPTION_SECRET);
}

/**
 * Decrypts xpriv from database (Admin-side, private key)
 * Uses WALLET_XPRIV_ENCRYPTION_SECRET for defense-in-depth
 */
export function decryptXpriv(encryptedXpriv: string): string {
  if (!config.WALLET_XPRIV_ENCRYPTION_SECRET) {
    throw new Error("WALLET_XPRIV_ENCRYPTION_SECRET is not configured");
  }
  return decryptWithSecret(encryptedXpriv, config.WALLET_XPRIV_ENCRYPTION_SECRET);
}
