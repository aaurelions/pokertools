import { SUITBIT_BY_ID, BINARIES_BY_ID } from "../tables/bit-masks";
import { SUITS_HASH } from "../tables/dp";
import { FLUSH_LOOKUP } from "../tables/flush";
import { NO_FLUSH_5 } from "../tables/no-flush-5";
import { NO_FLUSH_6 } from "../tables/no-flush-6";
import { NO_FLUSH_7 } from "../tables/no-flush-7";
import { hashQuinary } from "./hash";

/**
 * Scratch buffers reused by synchronous evaluations to avoid hot-path allocations.
 * Calls must not be re-entered through custom array getters/proxies. Normal arrays,
 * sequential calls and separate worker isolates do not share an active evaluation.
 */
const suitBinary = [0, 0, 0, 0];
const quinary = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Fast reset of static buffers.
 * Manual index assignment is faster than .fill(0).
 */
function resetBuffers(): void {
  suitBinary[0] = 0;
  suitBinary[1] = 0;
  suitBinary[2] = 0;
  suitBinary[3] = 0;

  quinary[0] = 0;
  quinary[1] = 0;
  quinary[2] = 0;
  quinary[3] = 0;
  quinary[4] = 0;
  quinary[5] = 0;
  quinary[6] = 0;
  quinary[7] = 0;
  quinary[8] = 0;
  quinary[9] = 0;
  quinary[10] = 0;
  quinary[11] = 0;
  quinary[12] = 0;
}

export function evaluate5Cards(cards: number[]): number {
  const c1 = cards[0],
    c2 = cards[1],
    c3 = cards[2],
    c4 = cards[3],
    c5 = cards[4];
  resetBuffers();

  // Populate suit hash
  const suitHash =
    SUITBIT_BY_ID[c1] +
    SUITBIT_BY_ID[c2] +
    SUITBIT_BY_ID[c3] +
    SUITBIT_BY_ID[c4] +
    SUITBIT_BY_ID[c5];

  // Populate rank frequency (quinary)
  quinary[c1 >> 2]++;
  quinary[c2 >> 2]++;
  quinary[c3 >> 2]++;
  quinary[c4 >> 2]++;
  quinary[c5 >> 2]++;

  // Check for flush; if found, use the flush lookup table
  if (SUITS_HASH[suitHash]) {
    suitBinary[c1 & 0x3] |= BINARIES_BY_ID[c1];
    suitBinary[c2 & 0x3] |= BINARIES_BY_ID[c2];
    suitBinary[c3 & 0x3] |= BINARIES_BY_ID[c3];
    suitBinary[c4 & 0x3] |= BINARIES_BY_ID[c4];
    suitBinary[c5 & 0x3] |= BINARIES_BY_ID[c5];

    return FLUSH_LOOKUP[suitBinary[SUITS_HASH[suitHash] - 1]];
  }

  const hash = hashQuinary(quinary, 13, 5);
  return NO_FLUSH_5[hash];
}

export function evaluate6Cards(cards: number[]): number {
  const c1 = cards[0],
    c2 = cards[1],
    c3 = cards[2],
    c4 = cards[3],
    c5 = cards[4],
    c6 = cards[5];
  resetBuffers();

  const suitHash =
    SUITBIT_BY_ID[c1] +
    SUITBIT_BY_ID[c2] +
    SUITBIT_BY_ID[c3] +
    SUITBIT_BY_ID[c4] +
    SUITBIT_BY_ID[c5] +
    SUITBIT_BY_ID[c6];

  quinary[c1 >> 2]++;
  quinary[c2 >> 2]++;
  quinary[c3 >> 2]++;
  quinary[c4 >> 2]++;
  quinary[c5 >> 2]++;
  quinary[c6 >> 2]++;

  if (SUITS_HASH[suitHash]) {
    suitBinary[c1 & 0x3] |= BINARIES_BY_ID[c1];
    suitBinary[c2 & 0x3] |= BINARIES_BY_ID[c2];
    suitBinary[c3 & 0x3] |= BINARIES_BY_ID[c3];
    suitBinary[c4 & 0x3] |= BINARIES_BY_ID[c4];
    suitBinary[c5 & 0x3] |= BINARIES_BY_ID[c5];
    suitBinary[c6 & 0x3] |= BINARIES_BY_ID[c6];

    return FLUSH_LOOKUP[suitBinary[SUITS_HASH[suitHash] - 1]];
  }

  const hash = hashQuinary(quinary, 13, 6);
  return NO_FLUSH_6[hash];
}

export function evaluate7Cards(cards: number[]): number {
  const c1 = cards[0],
    c2 = cards[1],
    c3 = cards[2],
    c4 = cards[3],
    c5 = cards[4],
    c6 = cards[5],
    c7 = cards[6];
  resetBuffers();

  const suitHash =
    SUITBIT_BY_ID[c1] +
    SUITBIT_BY_ID[c2] +
    SUITBIT_BY_ID[c3] +
    SUITBIT_BY_ID[c4] +
    SUITBIT_BY_ID[c5] +
    SUITBIT_BY_ID[c6] +
    SUITBIT_BY_ID[c7];

  quinary[c1 >> 2]++;
  quinary[c2 >> 2]++;
  quinary[c3 >> 2]++;
  quinary[c4 >> 2]++;
  quinary[c5 >> 2]++;
  quinary[c6 >> 2]++;
  quinary[c7 >> 2]++;

  if (SUITS_HASH[suitHash]) {
    suitBinary[c1 & 0x3] |= BINARIES_BY_ID[c1];
    suitBinary[c2 & 0x3] |= BINARIES_BY_ID[c2];
    suitBinary[c3 & 0x3] |= BINARIES_BY_ID[c3];
    suitBinary[c4 & 0x3] |= BINARIES_BY_ID[c4];
    suitBinary[c5 & 0x3] |= BINARIES_BY_ID[c5];
    suitBinary[c6 & 0x3] |= BINARIES_BY_ID[c6];
    suitBinary[c7 & 0x3] |= BINARIES_BY_ID[c7];

    return FLUSH_LOOKUP[suitBinary[SUITS_HASH[suitHash] - 1]];
  }

  const hash = hashQuinary(quinary, 13, 7);
  return NO_FLUSH_7[hash];
}
