# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Cryptographic Security for Production Games

### ⚠️ CRITICAL: Random Number Generation

**The default shuffle implementation now uses cryptographically secure random numbers when available.**

However, if you're deploying for real-money poker games, you MUST understand these security considerations:

#### Secure RNG (✅ Recommended)

```typescript
import { randomBytes } from "crypto";
import { PokerEngine } from "@pokertools/engine";

// Cryptographically secure RNG
const secureRng = () => {
  const buffer = randomBytes(4);
  return buffer.readUInt32BE(0) / 0x100000000;
};

const engine = new PokerEngine({
  smallBlind: 10,
  bigBlind: 20,
  randomProvider: secureRng, // Always provide this for production
});
```

#### Insecure RNG (❌ Never Use in Production)

```typescript
// ❌ NEVER DO THIS IN PRODUCTION
const engine = new PokerEngine({
  smallBlind: 10,
  bigBlind: 20,
  // Using default without providing randomProvider
  // Falls back to Math.random() in browser environments
});
```

### Why Math.random() is Dangerous

`Math.random()` uses a **predictable** pseudo-random algorithm:

1. **State is guessable** - Given enough observations, attackers can predict future cards
2. **Seed extraction** - Browser implementations leak seed via timing attacks
3. **Not cryptographically secure** - Designed for animations, not security

**Real-world attack:**

- Attacker observes 10-20 hands
- Reverse-engineers the PRNG state
- Predicts all future shuffles
- Knows everyone's hole cards

### Secure Shuffle for Production

Use one of these methods:

#### Option 1: Node.js crypto (Recommended)

```typescript
import { randomBytes } from "crypto";

const secureRng = () => randomBytes(4).readUInt32BE(0) / 0x100000000;
```

#### Option 2: Hardware RNG

```typescript
// Using hardware random number generator
const hardwareRng = () => {
  // Your hardware RNG implementation
};
```

#### Option 3: Provably Fair System

```typescript
import { createHash } from "crypto";

// Combine server seed + client seed for provably fair
function provablyFairRng(serverSeed: string, clientSeed: string, nonce: number) {
  return () => {
    const hash = createHash("sha256").update(`${serverSeed}:${clientSeed}:${nonce++}`).digest();
    return hash.readUInt32BE(0) / 0x100000000;
  };
}
```

## Security Best Practices

### 1. View Masking (Anti-Cheat)

**NEVER send full game state to clients:**

```typescript
// ❌ BAD: Exposes all hole cards and deck
socket.emit("gameState", engine.state);

// ✅ GOOD: Only send what player can see
const playerView = engine.view("playerId");
socket.emit("gameState", playerView);
```

### 2. Server-Side Validation

**ALWAYS validate actions on the server:**

```typescript
// ✅ Server validates all actions
app.post("/action", (req, res) => {
  try {
    const action = req.body;

    // Engine throws if action is illegal
    engine.act(action);

    res.json({ success: true });
  } catch (error) {
    if (error instanceof IllegalActionError) {
      res.status(400).json({ error: error.message });
    }
  }
});
```

### 3. Chip Conservation Auditing

Enable audit mode in production:

```typescript
import { getInitialChips } from "@pokertools/engine";

// After every action
const totalChips = getInitialChips(engine.state);
if (totalChips !== EXPECTED_TOTAL) {
  // CRITICAL ERROR: Freeze game immediately
  logger.critical("Chip integrity violation!", {
    expected: EXPECTED_TOTAL,
    actual: totalChips,
    gameId: game.id,
  });

  // Freeze table and alert admins
  freezeTable(game.id);
}
```

### 4. Integer Arithmetic Only

The engine uses **integer-only** arithmetic to prevent floating-point exploits:

```typescript
// All currency values in smallest unit (cents/satoshis)
const engine = new PokerEngine({
  smallBlind: 500, // $5.00 = 500 cents
  bigBlind: 1000, // $10.00 = 1000 cents
});

// Never use floating point
const stack = 10000; // ✅ 10000 cents
const stack = 100.0; // ❌ NEVER do this
```

### 5. Rate Limiting

Protect against automated attacks:

```typescript
import rateLimit from "express-rate-limit";

const actionLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 5, // Max 5 actions per second per IP
  message: "Too many actions, please slow down",
});

app.post("/action", actionLimiter, handleAction);
```

### 6. Session Management

Use secure session tokens:

```typescript
import session from "express-session";

app.use(
  session({
    secret: process.env.SESSION_SECRET, // 256-bit random key
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true, // HTTPS only
      httpOnly: true, // No JavaScript access
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);
```

## Reporting a Vulnerability

**DO NOT** open a public issue for security vulnerabilities.

Instead:

1. **Email**: `aurelions@protonmail.com`
2. **Include**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

3. **Response Time**:
   - Initial response: Within 48 hours
   - Status update: Within 7 days
   - Fix timeline: Depends on severity

### Severity Levels

- **Critical** (P0): RNG prediction, chip duplication
  - Fix: Within 24 hours
  - Bounty: Up to $5,000

- **High** (P1): Card visibility, bypass validation
  - Fix: Within 1 week
  - Bounty: Up to $1,000

- **Medium** (P2): Denial of service, timing attacks
  - Fix: Within 2 weeks
  - Bounty: Up to $500

- **Low** (P3): Minor information disclosure
  - Fix: Next release
  - Bounty: Recognition in CHANGELOG

## Security Checklist for Deployment

Before launching to production:

- [ ] Using cryptographically secure RNG
- [ ] Server-side validation enabled
- [ ] View masking implemented
- [ ] Chip conservation auditing active
- [ ] Rate limiting configured
- [ ] HTTPS only (no HTTP)
- [ ] Secure session management
- [ ] Database credentials encrypted
- [ ] Secrets in environment variables (not code)
- [ ] Logging enabled (but don't log sensitive data)
- [ ] Backup and disaster recovery tested
- [ ] Penetration testing completed

## Known Security Considerations

### 1. Timing Attacks

The evaluator uses lookup tables which have **constant-time** evaluation regardless of hand strength. However, network latency and server load can leak information.

**Mitigation**: Add random delay jitter to all responses:

```typescript
const delay = Math.floor(Math.random() * 50); // 0-50ms jitter
await new Promise((resolve) => setTimeout(resolve, delay));
```

### 2. Memory Dumps

The engine stores deck state in memory. If an attacker gains memory access, they can see the deck.

**Mitigation**:

- Use encrypted memory (TEE/SGX) for high-stakes games
- Rotate processes frequently
- Use process isolation

### 3. Replay Attacks

Without proper nonce/timestamp validation, attackers can replay old actions.

**Mitigation**:

```typescript
// Add timestamp validation
if (Date.now() - action.timestamp > 5000) {
  throw new Error("Action expired");
}

// Add nonce tracking
const processedNonces = new Set();
if (processedNonces.has(action.nonce)) {
  throw new Error("Duplicate action");
}
processedNonces.add(action.nonce);
```

## Security Updates

Subscribe to security updates:

- **GitHub Watch**: Click "Watch" → "Custom" → "Security alerts"
- **NPM**: `npm audit` will detect known vulnerabilities
- **RSS**: Subscribe to https://github.com/aaurelions/pokertools/releases.atom

## Compliance

This library follows:

- **OWASP Top 10** secure coding practices
- **CWE/SANS** Top 25 software errors prevention
- **PCI DSS** requirements for real-money gaming (when configured correctly)

## License

This security policy is part of the Pokertools project and follows the same MIT license.

---

**Last Updated**: 2025-11-29
**Version**: 1.0.0
