import { expectTypeOf, describe, it } from "vitest";
import type { WithdrawalRequest } from "../src/types";

describe("SDK type regressions", () => {
  it("allows withdrawal idempotencyKey supported by API", () => {
    expectTypeOf<WithdrawalRequest>().toMatchTypeOf<{
      amount: number;
      blockchainId: string;
      tokenId: string;
      address: string;
      message: string;
      signature: `0x${string}`;
      idempotencyKey?: string;
    }>();
  });
});
