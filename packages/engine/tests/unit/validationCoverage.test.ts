import { validateChipAmount, validateTimestamp } from "../../src/utils/validation";
import { ErrorCodes } from "../../src/errors/ErrorCodes";
import { IllegalActionError } from "../../src/errors/IllegalActionError";

describe("Validation Utilities", () => {
  describe("validateChipAmount", () => {
    test("throws on NaN", () => {
      try {
        validateChipAmount(NaN, "test");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_AMOUNT);
      }
    });

    test("throws on Infinity", () => {
      try {
        validateChipAmount(Infinity, "test");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_AMOUNT);
      }
    });

    test("throws on float", () => {
      try {
        validateChipAmount(10.5, "test");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_AMOUNT);
      }
    });

    test("throws on negative", () => {
      try {
        validateChipAmount(-1, "test");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_AMOUNT);
      }
    });

    test("accepts zero", () => {
      expect(() => validateChipAmount(0, "test")).not.toThrow();
    });

    test("accepts positive integer", () => {
      expect(() => validateChipAmount(100, "test")).not.toThrow();
    });
  });

  describe("validateTimestamp", () => {
    test("throws on invalid number", () => {
      try {
        validateTimestamp(NaN);
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_TIMESTAMP);
      }
    });

    test("throws on negative timestamp", () => {
      try {
        validateTimestamp(-100);
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_TIMESTAMP);
      }
    });

    test("throws on future timestamp (beyond tolerance)", () => {
      const future = Date.now() + 1000000; // Way in the future
      try {
        validateTimestamp(future);
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_TIMESTAMP);
      }
    });

    test("throws if timestamp is before previous timestamp", () => {
      const prev = 1000;
      const curr = 999;
      try {
        validateTimestamp(curr, prev);
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalActionError);
        expect((e as IllegalActionError).code).toBe(ErrorCodes.INVALID_TIMESTAMP);
      }
    });

    test("accepts equal timestamp", () => {
      const prev = 1000;
      const curr = 1000;
      expect(() => validateTimestamp(curr, prev)).not.toThrow();
    });

    test("accepts monotonic timestamp", () => {
      const prev = 1000;
      const curr = 1001;
      expect(() => validateTimestamp(curr, prev)).not.toThrow();
    });
  });
});
