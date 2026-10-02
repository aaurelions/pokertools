# Next-major implementation tracking (final)

Every mandatory requirement below is implemented and verified by executed
acceptance. Evidence and commands are recorded in
`ARCHITECTURE_CONVERGENCE_REPORT.md` (final convergence section).

| #   | Requirement                       | Status   |
| --- | --------------------------------- | -------- |
| 1   | Preserve checkpoints/current work | VERIFIED |
| 2   | Track requirements                | VERIFIED |
| 3   | Tournament regressions            | VERIFIED |
| 4   | PostgreSQL game CAS authority     | VERIFIED |
| 5   | Principal identity                | VERIFIED |
| 6   | Scoped SERVICE credentials        | VERIFIED |
| 7   | Auth-derived acting seat          | VERIFIED |
| 8   | Turn/Observation/LegalAction      | VERIFIED |
| 9   | Canonical action submission       | VERIFIED |
| 10  | Sole runtime/wire authority       | VERIFIED |
| 11  | Maintained SIWE                   | VERIFIED |
| 12  | Chips/assets separation           | VERIFIED |
| 13  | Asset identity                    | VERIFIED |
| 14  | No donation/AI domain             | VERIFIED |
| 15  | Immutable balanced atomic journal | VERIFIED |
| 16  | Ledger rebuild                    | VERIFIED |
| 17  | Account classes                   | VERIFIED |
| 18  | Multi-RPC registry                | VERIFIED |
| 19  | Settlement quorum                 | VERIFIED |
| 20  | Direct treasury deposit           | VERIFIED |
| 21  | Exact log identity                | VERIFIED |
| 22  | Optional sweeping                 | VERIFIED |
| 23  | Deposit deep finality/reorg       | VERIFIED |
| 24  | EIP-712 withdrawal/reserve        | VERIFIED |
| 25  | Narrow custody boundary           | VERIFIED |
| 26  | Telegram-independent workflow     | VERIFIED |
| 27  | Persist before broadcast          | VERIFIED |
| 28  | Ambiguous exact-byte recovery     | VERIFIED |
| 29  | Treasury nonce serialization      | VERIFIED |
| 30  | Explicit replacement policy       | VERIFIED |
| 31  | Withdrawal confirmation/finality  | VERIFIED |
| 32  | Withdrawal reorg obligations      | VERIFIED |
| 33  | Route operational state           | VERIFIED |
| 34  | Treasury reconciliation           | VERIFIED |
| 35  | Native gas readiness              | VERIFIED |
| 36  | Durable financial incidents       | VERIFIED |
| 37  | Auditable safe resolution         | VERIFIED |
| 38  | Real readiness                    | VERIFIED |
| 39  | Universal SDK                     | VERIFIED |
| 40  | No SDK legality authority         | VERIFIED |
| 41  | Shared SDK finance                | VERIFIED |
| 42  | Safe retry fault injection        | VERIFIED |
| 43  | Append-only bounded chat          | VERIFIED |
| 44  | Ordered events/outbox             | VERIFIED |
| 45  | Replay/audit                      | VERIFIED |
| 46  | SERVICE/mixed/10-seat acceptance  | VERIFIED |
| 47  | Redis loss/crash recovery         | VERIFIED |
| 48  | Timeout/action race               | VERIFIED |
| 49  | API-only four-table tournament    | VERIFIED |
| 50  | Two-chain/multi-asset Anvil       | VERIFIED |
| 51  | Finance/reorg/reconciliation acc. | VERIFIED |
| 52  | Real browser SDK acceptance       | VERIFIED |
| 53  | Schema/residue cleanup            | VERIFIED |
| 54  | Full verification/admission       | VERIFIED |
| 55  | Report/commits/clean tree         | VERIFIED |

## Final matrix

- `npm ci` → 0; `npm run build` → 0; `npm run typecheck` → 0; `npm run lint` → 0.
- `npm test` → 1400 passed, 1 skipped (API 452, custody 42, engine 397,
  evaluator 94, SDK 194, types 221).
- `test:postgres:migrations` 5/5; `test:loopback` 3/3; `contracts:test` 5/5.
- Canonical acceptance 16/16; two-chain finance acceptance 42/42; browser
  acceptance 1/1; Docker E2E 25/25.
- Runtime artifact: advisory CLI packages absent, PostgreSQL Prisma provider.
- Secret scan: 0 findings, canaries PASS (8 first-party paths).
- Production admission: verified evidence + safe configuration starts
  (`/health` 200, `/ready` 200); unsafe configuration fails closed.
