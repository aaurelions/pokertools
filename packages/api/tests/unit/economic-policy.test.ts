import { describe, expect, it } from "vitest";
import {
  assertOneChipRepresentable,
  atomicToChipsExact,
  chipsToAtomicExact,
  EconomicPolicyService,
  validatePolicyTerms,
} from "../../src/services/economic-policy.js";
import { EconomicPolicyError } from "../../src/services/economic-policy.js";

describe("economic policy exact conversion", () => {
  const basic = { chipsNumerator: 1n, atomicDenominator: 1_000_000n };

  it("converts chips to atomic exactly", () => {
    expect(chipsToAtomicExact(basic, 1n)).toBe(1_000_000n);
    expect(chipsToAtomicExact(basic, 5n)).toBe(5_000_000n);
  });

  it("converts atomic back to chips exactly", () => {
    expect(atomicToChipsExact(basic, 1_000_000n)).toBe(1n);
    expect(atomicToChipsExact(basic, 5_000_000n)).toBe(5n);
  });

  it("supports a non-unit numerator when the division is exact", () => {
    const policy = { chipsNumerator: 3n, atomicDenominator: 1000n };
    expect(chipsToAtomicExact(policy, 3n)).toBe(1000n);
    expect(chipsToAtomicExact(policy, 6n)).toBe(2000n);
    expect(atomicToChipsExact(policy, 1000n)).toBe(3n);
  });

  it("rejects a chip amount that does not divide exactly (no silent rounding)", () => {
    const policy = { chipsNumerator: 3n, atomicDenominator: 1000n };
    expect(() => chipsToAtomicExact(policy, 1n)).toThrow(EconomicPolicyError);
    expect(() => chipsToAtomicExact(policy, 2n)).toThrow(/exactly/);
  });

  it("rejects an atomic amount that does not divide exactly", () => {
    const policy = { chipsNumerator: 3n, atomicDenominator: 1000n };
    expect(() => atomicToChipsExact(policy, 500n)).toThrow(EconomicPolicyError);
  });

  it("rejects non-positive chip and atomic amounts", () => {
    expect(() => chipsToAtomicExact(basic, 0n)).toThrow(EconomicPolicyError);
    expect(() => atomicToChipsExact(basic, 0n)).toThrow(EconomicPolicyError);
  });

  it("rejects non-positive policy terms", () => {
    expect(() => validatePolicyTerms({ chipsNumerator: 0n, atomicDenominator: 1n })).toThrow(
      EconomicPolicyError
    );
    expect(() => validatePolicyTerms({ chipsNumerator: 1n, atomicDenominator: 0n })).toThrow(
      EconomicPolicyError
    );
    expect(() => EconomicPolicyService.validateTerms(1n, 0n)).toThrow(EconomicPolicyError);
  });

  describe("one-chip representability (production rule)", () => {
    it("accepts a rate where one chip maps to an integer atomic amount", () => {
      expect(
        assertOneChipRepresentable({ chipsNumerator: 1n, atomicDenominator: 1_000_000n })
      ).toBe(1_000_000n);
      expect(assertOneChipRepresentable({ chipsNumerator: 5n, atomicDenominator: 10_000n })).toBe(
        2000n
      );
    });

    it("rejects a rate where one chip would need a fractional atomic amount", () => {
      expect(() =>
        assertOneChipRepresentable({ chipsNumerator: 3n, atomicDenominator: 1000n })
      ).toThrow(EconomicPolicyError);
      expect(() =>
        assertOneChipRepresentable({ chipsNumerator: 3n, atomicDenominator: 1000n })
      ).toThrow(/not one-chip representable/);
    });
  });
});
