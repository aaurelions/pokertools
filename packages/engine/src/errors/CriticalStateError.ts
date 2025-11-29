import { PokerEngineError } from "./PokerEngineError";

/**
 * Critical error indicating state corruption or invariant violation
 * When this occurs, the table should be FROZEN immediately
 */
export class CriticalStateError extends PokerEngineError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super("CRITICAL_INVARIANT_FAILURE", message, context);
    this.name = "CriticalStateError";
  }
}
