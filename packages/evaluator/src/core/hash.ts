import { DP_MATRIX } from "../tables/dp";

/**
 * Perfect Hash algorithm for quinary sums.
 *
 * @param q - The frequency array of ranks (count of 2s, count of 3s, etc.)
 * @param len - Number of ranks (always 13)
 * @param k - Number of cards (5, 6, or 7)
 */
export function hashQuinary(q: number[], len: number, k: number): number {
  let sum = 0;

  for (let i = 0; i < len; i++) {
    sum += DP_MATRIX[q[i]][len - i - 1][k];
    k -= q[i];

    // Optimization: if we have accounted for all cards (k=0), we can stop early.
    if (k <= 0) break;
  }

  return sum;
}
