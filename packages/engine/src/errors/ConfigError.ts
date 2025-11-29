import { PokerEngineError } from "./PokerEngineError";

/**
 * Error indicating invalid configuration
 * Should fail at engine initialization
 */
export class ConfigError extends PokerEngineError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super("INVALID_CONFIG", message, context);
    this.name = "ConfigError";
  }
}
