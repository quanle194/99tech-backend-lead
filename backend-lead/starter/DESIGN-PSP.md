# Design: integrating the 50th PSP

**Goal:** a junior adds a PSP in a day, and most mistakes can only cause callbacks to be rejected. Provider code lives at the edge, turns each request into one canonical event, and cannot touch wallets or the ledger. The two mistakes that could still move money, a wrong status map and a `verify` that accepts everything, have their own controls.

## Sketch

```
 PSP --HTTP--> POST /psp/:provider/callbacks
     ┌──────────────── core, protected (CODEOWNERS: payments leads) ─────────┐
     │ 1. store raw request          psp_raw_callbacks, verified = null     │
     └───────────┬──────────────────────────────────────────────────────────┘
     ┌───────────┴──── junior-owned: src/psp/providers/<name>/ ──────────────┐
     │ 2. adapter.verify(raw)        signature, timestamp. Fail = 401 and   │
     │                               the stored row is marked unverified    │
     │ 3. adapter.normalize(raw)  -> CanonicalPspEvent | Ignore | Reject    │
     └───────────┬──────────────────────────────────────────────────────────┘
     ┌───────────┴──── core ──────────────────────────────────────────────────┐
     │ 4. applyPspEvent(event)       the Part A logic: funding-tx lock,     │
     │                               state machine, amount check, ledger    │
     └───────────┬──────────────────────────────────────────────────────────┘
               5. adapter.ack(outcome) -> the HTTP shape this PSP expects
```

## The interface

```ts
interface PspAdapter {
  readonly id: string;                                     // 'stripe', 'paysafe', ...
  verify(req: RawCallback, cfg: PspConfig): Promise<VerifyResult>;  // no DB; network only for PSPs that verify by API
  normalize(req: RawCallback, cfg: PspConfig): NormalizeResult;
  ack(outcome: CallbackOutcome | 'unverified' | 'unknown_ref' | 'ignored'): { status: number; body: unknown };
}

type NormalizeResult =
  | { kind: 'event'; event: CanonicalPspEvent }
  | { kind: 'ignore'; reason: string }   // statuses mapped to 'ignore', e.g. 'pending'
  | { kind: 'reject'; reason: string };  // unmapped status, malformed payload

interface CanonicalPspEvent {
  pspRef?: string;                   // ours, when the PSP echoes it
  providerRef?: string;              // the PSP's own transaction id otherwise
  providerEventId: string;           // UNIQUE (provider, providerEventId) dedupes the raw inbox; body hash if absent
  status: 'completed' | 'failed';
  amount: string;                    // decimal string, major units
  currency: string;
}

// Core entry point: resolves pspRef or (provider, providerRef) to the deposit, then runs Part A.
function applyPspEvent(provider: string, event: CanonicalPspEvent): Promise<CallbackOutcome>;

// src/psp/providers/acmepay/config.ts, the file a junior fills in:
export const acmepay: PspConfig = {
  adapter: 'acmepay',
  secretRef: 'vault://psp/acmepay/webhook',
  statusMap: { PAID: 'completed', DECLINED: 'failed', EXPIRED: 'failed', PENDING: 'ignore' },
  exponentOverrides: {},              // default: ISO 4217
  enabled: false,
  limits: { perTransaction: '1000', daily: '20000' },
  currencies: ['EUR', 'JPY'],
};
```

Adapters never touch the database: a lint rule (`no-restricted-imports`) fails the build if one imports `services/` or `db/`. Only `verify` may call the network, and only for PSPs that verify by API.

## Where verification and normalization live
- **Verification** runs first, in the adapter, on the raw bytes, because signature schemes are provider-specific. A failure returns 401, and the request goes no further than raw storage.
- **The raw request** is stored by the core before anything else, forged ones included, so probing is visible and a mapping bug can be fixed and replayed.
- **Normalization** parses fields and converts minor units using the currency's ISO 4217 exponent (JPY 0, BHD 3), overridable per provider. The **status map lives in config, not code**: the adapter only looks a status up, and an unmapped status is a `reject`.
- **Ordering and retries** are handled once, in the core. The Part A lock and state machine absorb duplicates, `success` before `pending`, and retry storms. `pending` maps to `ignore`, so it cannot move a deposit backwards.
- **Safety net:** the core compares amount and currency with what we asked for and fails closed, so a wrong exponent leaves the deposit `Pending` and audited. Part A is single-currency. Multi-PSP adds a `currency` column to `funding_txs`.
- **PSPs that never echo our reference** return their own id when we create the payment. We store it as `funding_txs.provider_ref`, UNIQUE per provider, and the core resolves it.

## Config drives it
Each provider has a typed entry, validated with zod at boot, so a bad config stops the service from starting. The entry holds the adapter id, a vault path to the secret, exponent overrides, the status map, an enabled flag, limits and allowed currencies. Payments leads own the config through CODEOWNERS, because a wrong status map (`declined` mapped to `completed`) is the one mistake the core cannot detect. A new PSP starts in shadow mode, open only to staff test accounts. Their events are normalised and logged, and their deposits are settled by hand until the reconciliation report matches. Then real players get it, under low limits.

## Testing without calling the provider
1. **Golden fixtures:** recorded, anonymised callbacks with their signatures and the test secret, stored next to the adapter.
2. **A shared contract suite** that every adapter must pass in CI. It requires one fixture per mapped status and a forged-signature fixture, and it checks exact minor-unit conversion, rejection of unknown statuses, one credit for duplicate or reordered deliveries, and the `ack` format. A new PSP supplies fixtures, and the tests already exist.
3. **A local simulator** replays fixtures with retries, concurrency and reordering against the real core.
4. **The provider sandbox** runs nightly outside CI, so a flaky third party never blocks a merge.

## The junior's day
`npm run psp:new <name>` scaffolds the adapter, config entry, fixture folder and contract-test registration. The junior writes them; CODEOWNERS applies per file, so `config.ts` needs a payments lead. The PR template asks for the fixture sources, the status map and the exponent. Today's `/psp/callbacks` becomes `/psp/mock/callbacks`.
