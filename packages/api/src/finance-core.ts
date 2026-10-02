/**
 * API finance-core export.
 *
 * Key-free accounting and chain-reading surface consumed by custody and room
 * workers through `@pokertools/api/finance-core`. Signing stays in custody.
 *
 * The API never holds signing keys. This barrel exposes public, DB-only
 * accounting primitives — no RPC URLs, no private keys, no signer factory.
 */

export {
  AtomicLedger,
  ConcurrentLedgerModificationError,
  LedgerConflictError,
  LedgerInvariantError,
  computeJournalPayloadHash,
  isTransientTransactionConflict,
  isUniqueViolation,
  parseSignedAtomic,
  runTransactionWithRetry,
  serializeSignedAtomic,
  type AtomicBalance,
  type LedgerPostInput,
  type LedgerPostingInput,
  type PostedJournal,
} from "./services/atomic-ledger.js";

export {
  FinancialIntentService,
  withdrawalIntentFingerprint,
  withdrawalRecordFingerprint,
  WITHDRAWAL_DOMAIN_NAME,
  WITHDRAWAL_DOMAIN_VERSION,
  type ReserveWithdrawalInput,
  type ReserveWithdrawalResult,
  type WithdrawalPrincipal,
} from "./services/financial-intents.js";

export {
  FinancialIncidentService,
  DEFAULT_RECONCILIATION_MAX_AGE_MS,
  type IncidentReadinessCheck,
  type OpenCriticalIncidentInput,
  type OpenCriticalIncidentResult,
  type OpenIncidentInput,
  type RecordReconciliationInput,
  type ResolveIncidentInput,
} from "./services/financial-incidents.js";

export {
  CanonicalDepositService,
  DepositClaimRejected,
  type ClaimInput,
  type ClaimResult,
  type DepositClaimVerification,
  type DepositClaimVerificationInput,
  type DepositClaimVerifier,
} from "./services/canonical-deposits.js";

export {
  ChainRegistry,
  ChainFrozenError,
  RpcChainMismatchError,
  RpcDisagreementError,
  RpcDuplicateEndpointError,
  RpcEndpointError,
  RpcQuorumError,
  assertUniqueEndpoints,
  createDefaultRpcClient,
  parseErc20Transfer,
  redactEndpointUrl,
  sanitizeErrorMessage,
  type CanonicalReceipt,
  type ChainRegistryOptions,
  type IncidentSink,
  type NormalizedBlock,
  type NormalizedLog,
  type NormalizedReceipt,
  type QuorumReader,
  type RegistryIncident,
  type RegistryIncidentEvidence,
  type RpcEndpointConfig,
} from "./services/chain-registry.js";

// API-owned custody adapters (ledger-only accounting + ChainRegistry-backed
// quorum reads). Exposed through the finance-core barrel so the isolated
// custody runtime consumes compiled, key-free implementations.
export {
  createCustodyAccounting,
  type CustodyAccountingIncident,
  type CustodyAccountingOptions,
  type CustodyAccountingRecord,
  type CustodyReconciliationEvidence,
  type CustodyTreasuryAccounting,
} from "./services/custody-accounting.js";

export {
  createAssetBackedCustodyQuorumReader,
  createCustodyQuorumReader,
  type AssetBackedCustodyQuorumReaderOptions,
  type CreateCustodyQuorumReaderOptions,
  type CustodyAssetLike,
  type CustodyBlockObservation,
  type CustodyBlockTag,
  type CustodyChainRegistryLike,
  type CustodyQuorumReader,
  type CustodyQuorumResult,
  type CustodyReceiptObservation,
  type CustodyTransferLog,
} from "./services/custody-chain-reader.js";
