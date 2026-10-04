# Rate limiting (2.0.1)

The application limit remains **100 requests/minute** (`RATE_LIMIT_MAX`).
Authenticated REST routes resolve and verify the wallet DB session or opaque
SERVICE credential in `onRequest`. The application limiter runs in `preParsing`
and keys on the verified principal's kind and ID, not the credential or IP.
Different verified principals sharing an egress address have independent
application budgets. Credential rotation, new sessions and new connections do
not change a principal's budget. Invalid/revoked credentials cannot choose a
trusted identity; unauthenticated routes use a normalized client-IP key.
Observation, action and chat share that application bucket; redundant chat
route overrides no longer allocate extra per-route application budgets.

A separate instance-level `onRequest` guard runs **before credential
verification**. `RATE_LIMIT_NETWORK_MAX` defaults to 1000/minute per normalized
client IP (including IPv6 subnet normalization). It bounds the aggregate cost
of valid and invalid credentials from one source; it does not replace or raise
the 100/minute application budget. Both stores remain per API process, matching
2.0.0 storage semantics, and do not make health/readiness depend on Redis.
Size the coarse network boundary for deployment capacity, not to bypass an
application's request budget. Both layers return 429 with `Retry-After`.

Authentication nonce/login remain strict **5/10 requests/minute per IP**,
respectively. Their `onRequest` limits also charge malformed request bodies.
Authorization, table scopes, session revocation and financial rules are unchanged.

## Reverse proxies

Default `trustProxy` is **false**: direct clients cannot rotate IP buckets by
forging `X-Forwarded-For`. Set `TRUSTED_PROXY_CIDRS` to a comma-separated list
of the actual ingress proxy IPs or narrowly owned CIDRs. An explicit `/0`,
boolean/hop-count shortcut, hostname or malformed address is rejected.
Trusted proxies must overwrite/append forwarded headers with the actual client
address; untrusted peers and forged prefixes beyond the first untrusted hop
cannot choose the client IP.

The shipped Caddy configuration overwrites `X-Forwarded-For` with its remote
client. Reserve Caddy's address and configure that exact address (for example,
`TRUSTED_PROXY_CIDRS=172.30.0.10/32` **only if that is your reserved ingress**).
Do not trust the entire Compose `internal` bridge: workers, database and other
non-proxy peers also share it. With proxy trust left empty, authenticated
principal budgets remain correct, but unauthenticated IP budgets are shared
at the proxy address. No arbitrary client identity header is trusted.

In 2.0.0 the default plugin used an IP-only application key in `onRequest`.
It appended its hook after existing route authentication, so early auth
rejections could bypass it; independent verified principals still shared the
same application bucket. The two explicit boundaries above correct both issues.
