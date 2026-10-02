import { PokerEngine, type Action } from "@pokertools/engine";
import { ActionType, PlayerStatus, Street, type LegalAction } from "@pokertools/types";

/**
 * Canonical legal-action generation.
 *
 * `getLegalActions(engine, turnId, principalId)` returns the exact actions the
 * acting principal may submit for the observed turn, using `engine.validate`
 * as the single source of legality. Action ids are opaque and turn-scoped
 * (`${turnId}:${family}`), so an id issued for one turn can never be replayed
 * against another. Betting families carry minAmount/maxAmount; CALL may carry
 * an exact amount.
 *
 * Only simple, seat-scoped gameplay families are exposed. Management families
 * (STAND, NEXT_BLIND_LEVEL, SIT, ADD_CHIPS, RESERVE_SEAT) are deliberately not
 * offered through the generic public action route.
 */
export function getLegalActions(
  engine: PokerEngine,
  turnId: string,
  principalId: string | null
): LegalAction[] {
  if (!turnId) return [];

  const state = engine.state;
  const actionTo = state.actionTo;

  // No betting decision is pending: a seated principal may deal when the engine
  // permits it, and may show/muck at showdown.
  if (actionTo === null) {
    const seated = principalId !== null && state.players.some((p) => p?.id === principalId);
    if (!seated) return [];

    const idle: LegalAction[] = [];
    if (engine.validate({ type: ActionType.DEAL }).valid) {
      idle.push({ actionId: id(turnId, "DEAL"), family: "DEAL" });
    }
    if (state.street === Street.SHOWDOWN) {
      if (engine.validate({ type: ActionType.SHOW, playerId: principalId }).valid) {
        idle.push({ actionId: id(turnId, "SHOW"), family: "SHOW" });
      }
      if (engine.validate({ type: ActionType.MUCK, playerId: principalId }).valid) {
        idle.push({ actionId: id(turnId, "MUCK"), family: "MUCK" });
      }
    }
    return idle;
  }

  if (principalId === null) return [];

  const player = state.players[actionTo];
  if (!player || player.id !== principalId) return [];
  if (player.status !== PlayerStatus.ACTIVE) return [];

  const currentBet = Math.max(0, ...state.currentBets.values());
  const playerBet = state.currentBets.get(actionTo) ?? 0;
  const toCall = Math.max(0, currentBet - playerBet);
  const maxTotal = playerBet + player.stack;

  const allowed = (action: Action): boolean => engine.validate(action).valid;

  const actions: LegalAction[] = [];

  if (allowed({ type: ActionType.FOLD, playerId: principalId })) {
    actions.push({ actionId: id(turnId, "FOLD"), family: "FOLD" });
  }

  if (toCall === 0 && allowed({ type: ActionType.CHECK, playerId: principalId })) {
    actions.push({ actionId: id(turnId, "CHECK"), family: "CHECK" });
  }

  if (toCall > 0) {
    const callAmount = Math.min(toCall, player.stack);
    if (allowed({ type: ActionType.CALL, playerId: principalId, amount: callAmount })) {
      actions.push({ actionId: id(turnId, "CALL"), family: "CALL", amount: callAmount });
    }
  }

  if (currentBet === 0 && player.stack > 0) {
    const minAmount = Math.min(state.bigBlind, maxTotal);
    if (
      allowed({ type: ActionType.BET, playerId: principalId, amount: minAmount }) &&
      allowed({ type: ActionType.BET, playerId: principalId, amount: maxTotal })
    ) {
      actions.push({
        actionId: id(turnId, "BET"),
        family: "BET",
        minAmount,
        maxAmount: maxTotal,
      });
    }
  }

  if (currentBet > 0 && maxTotal > currentBet) {
    // A short all-in that cannot reach the minimum raise-to is the only legal
    // raise (raise-to total = the player's maximum wager).
    const minAmount = Math.min(state.minRaise, maxTotal);
    if (
      allowed({ type: ActionType.RAISE, playerId: principalId, amount: minAmount }) &&
      allowed({ type: ActionType.RAISE, playerId: principalId, amount: maxTotal })
    ) {
      actions.push({
        actionId: id(turnId, "RAISE"),
        family: "RAISE",
        minAmount,
        maxAmount: maxTotal,
      });
    }
  }

  if (state.street === Street.SHOWDOWN && player.hand && player.hand.length > 0) {
    const indices = player.hand.map((_, index) => index).filter((index) => index <= 1);
    if (allowed({ type: ActionType.SHOW, playerId: principalId, cardIndices: indices })) {
      actions.push({ actionId: id(turnId, "SHOW"), family: "SHOW" });
    }
    if (allowed({ type: ActionType.MUCK, playerId: principalId })) {
      actions.push({ actionId: id(turnId, "MUCK"), family: "MUCK" });
    }
  }

  if (player.timeBank > 0 && allowed({ type: ActionType.TIME_BANK, playerId: principalId })) {
    actions.push({ actionId: id(turnId, "TIME_BANK"), family: "TIME_BANK" });
  }

  return actions;
}

function id(turnId: string, family: LegalAction["family"]): string {
  return `${turnId}:${family}`;
}
