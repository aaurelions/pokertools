/**
 * Base error class for all poker engine errors
 */
export class PokerEngineError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;

  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "PokerEngineError";
    this.code = code;
    this.context = context;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
