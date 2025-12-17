/**
 * Browser-compatible entry point for PokerEngine
 *
 * This file provides a browser-safe RNG using Web Crypto API
 * and re-exports all engine functionality for use in web applications.
 */

import { PokerEngine } from "./engine/PokerEngine";
import type { TableConfig } from "@pokertools/types";

/**
 * Browser-compatible RNG using Web Crypto API
 * Falls back to Math.random() only in environments without crypto
 */
export function getBrowserRNG(): () => number {
  // Check for Web Crypto API
  if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
    return () => {
      const buffer = new Uint32Array(1);
      window.crypto.getRandomValues(buffer);
      return buffer[0] / 0x100000000;
    };
  }

  // Check for Node.js crypto (for SSR/testing)
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    return () => {
      const buffer = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buffer);
      return buffer[0] / 0x100000000;
    };
  }

  // Fallback (warn in development)
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[PokerEngine Browser] Web Crypto API not available, using Math.random(). " +
        "This is NOT cryptographically secure."
    );
  }

  return Math.random;
}

/**
 * Create a PokerEngine instance with browser-compatible RNG
 */
export function createBrowserEngine(config: TableConfig): PokerEngine {
  return new PokerEngine({
    ...config,
    randomProvider: getBrowserRNG(),
  });
}

// Re-export everything from main engine
export * from "./engine/PokerEngine";
export * from "./actions/betting";
export * from "./actions/dealing";
export * from "./actions/management";
export * from "./actions/showdownActions";
export * from "./actions/special";
export * from "./utils/viewMasking";
export * from "./utils/serialization";
export * from "./utils/cardUtils";
export * from "./history/exporter";
