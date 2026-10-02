# Integration invariants

These decisions govern the parallel implementation. No production admission is
granted by this document.

## Authority and identities

- An engine player ID is the authenticated principal ID, never a wallet address.
  Wallet authentication and service authentication attach the same principal
  interface. SERVICE credentials convey gameplay scope, not operator or finance
  authority. Revocation and resource restrictions apply to HTTP and WebSocket.
- Public action submission is strict `{requestId, turnId, expectedVersion,
actionId, amount?}`. Action identities are issued for one canonical turn;
  parameter bounds come from engine validation. Clients never select an actor.
- A duplicate request returns its original result only when actor and complete
  payload match. Authentication/authorization still precede duplicate lookup.
- PostgreSQL CAS commits the snapshot, accepted action, ordered immutable events,
  idempotency result and outbox together. Redis failure cannot undo a commit or
  make its response a falsely rejected action. Cache contents are never authority.
- Durable audit may contain private engine data only behind an explicit private
  audit boundary. Public replay/events must never contain another seat's cards,
  unrevealed deck, or unmasked original action/snapshot payload.

## Asset accounting

- Engine chips and asset atomic amounts are different units. No default asset,
  cents convention or implicit chip exchange rate is permitted.
- Asset identity is chain-qualified and token-qualified. Atomic amounts are
  arbitrary-precision integers encoded as canonical decimal strings.
- Every journal transaction is immutable, balanced, and belongs to one asset.
  Projections are rebuildable. User liability classes normally have nonnegative
  credit balances; TREASURY_RESERVE is the signed external-asset counterparty.
- A deposit of `a`: USER_AVAILABLE `+a`, TREASURY_RESERVE `-a`.
- A withdrawal reserve: USER_AVAILABLE `-a`, PENDING_WITHDRAWAL `+a`.
- Confirmed payout: PENDING_WITHDRAWAL `-a`, TREASURY_RESERVE `+a`.
- A withdrawal reorg after completion restores the economic obligation exactly
  once: INCIDENT_OBLIGATION `+a`, TREASURY_RESERVE `-a`. It does not debit the
  user again. Pre-completion reorgs retain the existing pending obligation.
- A deposit reorg preserves the already credited user liability. Its loss is a
  documented shortfall, not a second user liability: do not credit an additional
  `+a` obligation and accidentally double-count what the platform owes.
- Reconciliation compares on-chain token custody with signed net internal
  liabilities/equity, excluding the external counterparty account. Incidents are
  evidence and obligations, not permission to edit or delete journal history.

## Custody and financial risk

- Treasury nonce ownership is serialized per `(chainId, treasuryAddress)` in the
  durable store. Signed bytes/hash/nonce/call are committed before broadcast.
- NO_AUTOMATIC_REPLACEMENT. Ambiguous broadcasts are recovered by observation
  and reuse of the same bytes/hash, never by a new debit, nonce, or blind refund.
- Settlement receipts, canonical blocks, native gas and treasury token custody
  use validated endpoint quorum. Disagreement fails closed with durable evidence.
- Freeze blocks new financial risk but never monitoring of existing obligations.
  Gas starvation blocks signing without erasing/resolving/refunding the obligation.
- Resolution must recheck all blocking incidents, ledger invariants, quorum,
  reconciliation and gas under a concurrency-safe route state transition.
- EIP-712 withdrawal domain: `PokerTools Withdrawal`, version `1`, chain ID and
  treasury verifying contract. The signed message binds intentId, principalId,
  assetId, destination, amountAtomic, nonce, deadline and chainId. Deadline is
  Unix seconds. Service gameplay credentials cannot authorize withdrawals.
