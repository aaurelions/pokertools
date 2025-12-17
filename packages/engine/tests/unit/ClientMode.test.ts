import { PokerEngine, ActionType } from "../../src";

describe("Client Mode Engine", () => {
  const config = {
    smallBlind: 10,
    bigBlind: 20,
    maxPlayers: 6,
    isClient: true,
  };

  it("should initialize in client mode", () => {
    const engine = new PokerEngine(config);
    expect(engine.state.config.isClient).toBe(true);
  });

  it("should deal masked cards in client mode", () => {
    const engine = new PokerEngine(config);
    engine.sit(0, "p1", "Player 1", 1000);
    engine.sit(1, "p2", "Player 2", 1000);
    
    engine.deal();

    const p1 = engine.state.players[0];
    expect(p1?.hand).toEqual([null, null]);
    expect(engine.state.deck).toEqual([]);
  });

  it("should validate actions without executing", () => {
    const engine = new PokerEngine(config);
    engine.sit(0, "p1", "Player 1", 1000);
    engine.sit(1, "p2", "Player 2", 1000);
    engine.deal();

    // Valid action
    const validResult = engine.validate({
      type: ActionType.FOLD,
      playerId: "p1" // SB acts first
    });
    expect(validResult.valid).toBe(true);

    // Invalid action (wrong turn)
    const invalidResult = engine.validate({
      type: ActionType.FOLD,
      playerId: "p2"
    });
    expect(invalidResult.valid).toBe(false);
    if (!invalidResult.valid) {
      expect(invalidResult.error).toBeDefined();
    }
  });

  it("should support optimistic actions", () => {
    const engine = new PokerEngine(config);
    engine.sit(0, "p1", "Player 1", 1000);
    engine.sit(1, "p2", "Player 2", 1000);
    engine.deal();

    // Initial state
    const initialTimestamp = engine.state.timestamp;

    // Optimistic fold
    const nextState = engine.optimisticAct({
      type: ActionType.FOLD,
      playerId: "p1"
    });

    // Engine state should NOT have changed
    expect(engine.state.timestamp).toBe(initialTimestamp);
    
    // Returned state SHOULD be updated
    expect(nextState.players[0]?.status).toBe("FOLDED");
  });

  it("should reconcile server state", () => {
    const clientEngine = new PokerEngine(config);
    
    // Simulate a server state (PublicState)
    // We create a server engine to generate it
    const serverEngine = new PokerEngine({ ...config, isClient: false });
    serverEngine.sit(0, "p1", "Player 1", 1000);
    serverEngine.sit(1, "p2", "Player 2", 1000);
    serverEngine.deal();

    const publicView = serverEngine.view("p1");

    // Reconcile on client
    clientEngine.reconcile(publicView);

    expect(clientEngine.state.handNumber).toBe(1);
    expect(clientEngine.state.players[0]?.stack).toBe(990); // SB posted
    expect(clientEngine.state.players[0]?.hand).toHaveLength(2);
    // In public view for p1, p1 sees cards, p2 has null (completely hidden)
    expect(clientEngine.state.players[1]?.hand).toBeNull();
  });
});
