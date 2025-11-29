import { PokerEngineError } from "./PokerEngineError";
import { ErrorCode } from "./ErrorCodes";

/**
 * Error indicating an illegal or invalid action
 * Action should be rejected and error sent to client
 */
export class IllegalActionError extends PokerEngineError {
  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(code, message, context);
    this.name = "IllegalActionError";
  }
}
