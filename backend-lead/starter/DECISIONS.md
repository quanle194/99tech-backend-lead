# Decisions

## Status
Part A is complete, Part B is in `DESIGN-PSP.md`, and withdrawal approval is not built. Run `npm run db:up && npm test`. Read first: services, the four migrations, tests. Extras closing money holes: idempotency keys, signed callbacks, invariant triggers.

## Money invariants
`assertWalletInvariants` reconciles I1–I4, I6 and I8 after every money test; the database guards all of them.

- **I1** `wallets.balance = SUM(wallet_txs.amount)`. Only `walletService.applyEntry` changes a balance, always with its ledger row. A deferred constraint trigger fails any commit where a balance differs from its latest `balance_after`.
- **I2** `balance >= 0`: checked in `applyEntry` under the lock, backed by CHECKs.
- **I3/I4** A completed deposit or a withdrawal has exactly one ledger entry for its amount, and other deposits have none. A UNIQUE index allows at most one, an insert trigger checks wallet, type and amount, a commit-time trigger requires one.
- **I5** Status only moves Pending to Completed or Failed. `fundingTxStateMachine` is the source of truth; the conditional `UPDATE`, CHECK and trigger are backstops. New statuses touch the map and the CHECK.
- **I6** Turnover counters equal their source rows: each entry records the counters after it, checked by the same triggers as balance.
- **I7** The ledger and the callback audit are append-only: a trigger rejects UPDATE and DELETE (not `TRUNCATE`, which tests use; production would not grant it).
- **I8** `balance_after` chains entry by entry: a `BEFORE INSERT` trigger that takes the wallet lock. A writer skipping the lock can interleave ids (assigned before the trigger); the commit-time check rejects that.

## Assumptions
| Gap in the brief | Assumption |
|---|---|
| Callback amount differs | 409 `amount_mismatch`, no credit, stays `Pending`, audited. Compared as decimals (`100.5` = `100.50`) |
| Unknown `pspRef` | 404 and nothing written, so an unauthenticated caller cannot fill the money schema. Part B's raw inbox makes probing visible |
| Redelivered terminal callback | Same status (any amount if `failed`): 200 `duplicate`. Else 409 |
| `failed` callback | Terminal whatever its amount: no money moves, and PSPs often send `0` on failure. A later `completed` gets 409 and lands in the `deposits_needing_reconciliation` view |
| Turnover scope | Totals, as the brief words it, so earlier wagers count: wager 1,000, deposit 1,000 at ×1, withdraw at once. Exposure is bounded by earlier real wagering. Per-deposit tracking closes it (next #4) |
| Insufficient balance | 422 `insufficient_funds`, checked after turnover (the rule to act on first) |
| Client retries | Optional `Idempotency-Key` on wagers and withdrawals. Without it, each request is a new debit |
| Bounds (my choice) | Requests: `amount` ≤ 1e9, ≤ 18 decimals (Postgres silently rounds a 19th), multiplier 0..100. Callbacks accept any `DECIMAL(36,18)`, so a wrong amount is audited, not dropped as a 400 |
| Callback authenticity | HMAC `X-Psp-Signature` with `PSP_WEBHOOK_SECRET`. Without one, callbacks get 401 unless `PSP_ALLOW_UNSIGNED=true` (in `.env.example`, for the unsigned mock); production requires a secret. Players see their `pspRef` |
| Currency, ids | Single currency. Unknown ids 404, malformed ids 400 |

## Data model
- **`funding_txs`**: one row per deposit or withdrawal; `psp_ref` UNIQUE, per-type field CHECKs, a wallet-member composite FK.
- **`wallet_txs`**: the ledger. `amount` is **signed** (a CHECK ties sign to type), so I1 is one `SUM`. I rejected positive amounts plus a direction column, since every reconciliation then needs a `CASE`. `balance_after` makes history auditable without replay.
- **`psp_callback_events`**: an audit row per callback on a known ref.
- **Turnover counters on `wallets`**: an O(1) check under the lock already held, cached from the source rows. Rejected: `SUM` per withdrawal (slows with history), per-deposit tracking (outside the brief).
- `VARCHAR` plus `CHECK` instead of Postgres enums, so adding a value needs no `ALTER TYPE`.
- **Rejecting a withdrawal** (not built): a `WithdrawalReversal` credit on the same `funding_tx_id`, after a migration extends the type CHECK and the funding-match trigger. The UNIQUE then allows exactly one.

## Locking and idempotency
Each money-moving operation is one transaction at READ COMMITTED with `SELECT ... FOR NO KEY UPDATE`, which serialises writers without blocking the FK `KEY SHARE` lock that `POST /deposits` takes on the wallet. A 2s `lock_timeout` turns a hung lock holder into a retryable 503.

- The **wallet row** guards balance, turnover and idempotency keys; the **funding transaction row** guards its transitions.
- **Lock order is funding transaction, then wallet.** Only callbacks hold both, so there is no cycle and no deadlock.

A deposit is credited exactly once by three layers, each checked by removing it and watching a test fail:
1. The row lock on the funding transaction makes concurrent deliveries queue. Each re-reads the committed status and answers `duplicate`.
2. `UPDATE funding_txs ... WHERE status = 'Pending'` must hit one row. Without the lock, losers get a 500, not a second credit.
3. `UNIQUE (funding_tx_id, type)`. Without both of the above, the database still rejects the second credit.

| Rejected | Why |
|---|---|
| Optimistic locking | Retry loops everywhere, and PSP retries on a hot wallet become a storm |
| SERIALIZABLE | Every path must catch `40001` and retry, and conflicts depend on the query plan |
| `UPDATE ... SET balance = balance - x WHERE balance >= x` | One counter only, but we also write `balance_after` and turnover |
| Advisory or Redis locks | A second coordination system outside the transaction |
| UNIQUE alone | The losing request gets a 500, not an idempotent 200 |

The accepted trade-off is contention within one wallet, which is one member's own activity. Known costs: waiters hold pool connections, so five stuck on one hot wallet can starve a pool of 5, and the triggers add about three indexed lookups per operation. The idempotency key lives on the ledger row: a replay returns the original entry, and a failed first attempt (such as a 422) leaves no row, so its retry is a new attempt.

**Triggers re-check business rules on purpose.** The turnover delta and "credit only a Completed deposit" exist in TypeScript and plpgsql, so changing a rule needs code plus a migration. I accept that for rules whose silent violation moves money. Each guard lives in its table's migration.

## PSP callback policy
2xx means the callback's intent is applied, now or earlier, so retries are harmless. Rejections get a 4xx and an audit row, which commits because rejected outcomes are returned, not thrown. A mismatch stays `Pending`: crediting the PSP's amount would turn an adapter bug (minor units) into minted money, and `Failed` would block a correct callback that arrives later. I chose 4xx over "200 and park" so the PSP sees the problem too, at the price of one audit row per retry.

## Testing
Tests run over HTTP against real Postgres and assert responses and database state. Concurrency tests send 20 requests to one server. A pool of 5 caps overlap at five transactions, which is enough: a race needs two, and each test fails once its lock is removed. Beyond the required four: more races, turnover one unit short, idempotency, signatures, lock timeouts, database guards, a seeded randomized mix.

Each concurrency test was checked to fail with its lock removed. That caught a fake test: before the pool was warmed (`test/helpers/server.ts`), the first concurrent test in a file never raced and passed without the callback lock.

## Deviations from the starter conventions
One deliberate one: some business rules are re-checked in plpgsql (above). Additions: uuid validation on the starter's wallet route, `toMoneyString`, error mappings (400, 401, 503), pool and timeouts, the signature middleware. Dependencies added: none.

## Known limitations
- Signing: one secret, no replay window.
- Mismatches and `completed` after `failed` wait in `deposits_needing_reconciliation`, unalerted.
- No audit retention.
- Review fixes after the first build were squashed into thematic commits.
- The extras exceed the 4-hour budget.
- Two business rules live in both TypeScript and plpgsql.

## What I would do next
1. The adapter boundary from `DESIGN-PSP.md`, with key rotation.
2. Alerts on mismatches and stale `Pending` deposits; reconciliation against PSP reports.
3. Withdrawal approve/reject via the same state machine, crediting back on reject.
4. Per-deposit turnover.
5. Mandatory `Idempotency-Key`, an outbox, lock-wait metrics.

## AI disclosure
Before any code was generated I prepared a written design brief that fixed the core decisions here: row locks and their order, the signed ledger with `balance_after`, failing closed on mismatches, 404 for unknown refs, lifetime turnover, and what not to build.

Claude Code (Claude Opus 5.5) then worked from that brief as a coding agent: it wrote the specification, code, tests and these documents, and ran the checks. Independent AI review passes changed the design: the idempotency key and callback signing (out of scope in the brief), the triggers, and `NO KEY UPDATE` with a lock timeout.
