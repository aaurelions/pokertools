# @pokertools/custody

Isolated withdrawal signer/worker. Custody is the only process that holds treasury
signing keys; the API reserves EIP-712 withdrawal intents and never loads key
material. The runtime starts a timer-driven worker that signs and broadcasts exact
persisted bytes under a multi-RPC quorum, monitors confirmations and reorgs, and
reconciles treasury custody against the ledger.

The package README documents the lifecycle, signing isolation, ports,
configuration and tests:

- [Custody README](https://github.com/aaurelions/pokertools/blob/main/packages/custody/README.md)
- [Cross-package finance acceptance](https://github.com/aaurelions/pokertools/blob/main/packages/e2e/tests/finance/README.md)
