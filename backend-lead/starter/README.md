# Mini Wallet Service - Starter

This is the starter codebase for the Backend Lead take-home. The task itself is described in [`../readme.md`](../readme.md).

## Stack

TypeScript, Express, Sequelize, PostgreSQL, Jest. Money is `DECIMAL(36,18)` in Postgres, strings in JS/JSON, and all arithmetic goes through `bignumber.js` (see `src/lib/money.ts`).

## Setup

Requires Node 20+ and Docker.

```bash
cp .env.example .env
npm install
npm run db:up        # starts Postgres on localhost:5439 (dev + test databases)
npm run db:migrate   # migrates the dev database
npm test             # migrates the test database and runs the test suite
npm run dev          # starts the API on :3000
```

If port 5439 clashes with something on your machine, change it in `docker-compose.yml` and `.env`.

## Layout

```
src/
├── app.ts               # express app factory
├── index.ts             # entrypoint
├── config.ts
├── lib/money.ts         # BigNumber helpers - use these for all money math
├── db/
│   ├── sequelize.ts
│   ├── cli-config.js    # sequelize-cli config (used by npm run db:migrate)
│   ├── migrations/      # add your migrations here
│   └── models/
├── routes/
└── services/
test/                    # add your tests here
```

## Conventions to keep

- Money never touches JS `number`. Strings at the boundaries, BigNumber in between.
- Any operation writing more than one row runs in a single DB transaction (see `memberService.createMember`).
- Routes validate input with zod and delegate to services; business logic lives in services, not routes.
- New tables are created via migrations, not `sync()`.

## Candidate notes

Design trade-offs, assumptions and next steps are in [`DECISIONS.md`](DECISIONS.md). Part B is in [`DESIGN-PSP.md`](DESIGN-PSP.md). Setup is unchanged: `.env.example` sets `PSP_ALLOW_UNSIGNED=true` for the brief's unsigned mock PSP. Set `PSP_WEBHOOK_SECRET` instead to require HMAC-signed callbacks. `npm test` migrates the test database and runs everything, including the concurrency tests.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/deposits` | Create a `Pending` deposit and return its `pspRef`. No money moves |
| POST | `/psp/callbacks` | PSP webhook. Credits a completed deposit exactly once |
| POST | `/wallets/:walletId/wagers` | Debit a wager and accrue turnover. Optional `Idempotency-Key` header |
| POST | `/withdrawals` | Debit now and create a `Pending` withdrawal, gated by turnover. Optional `Idempotency-Key` header |

A sample flow (run against `npm run dev`):

```bash
M=$(curl -s -XPOST localhost:3000/members -H 'Content-Type: application/json' -d '{"username":"alice01"}')
MID=$(echo "$M" | node -pe 'JSON.parse(require("fs").readFileSync(0)).member.id')
WID=$(echo "$M" | node -pe 'JSON.parse(require("fs").readFileSync(0)).wallet.id')
D=$(curl -s -XPOST localhost:3000/deposits -H 'Content-Type: application/json' -d "{\"memberId\":\"$MID\",\"amount\":\"100\"}")
REF=$(echo "$D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).pspRef')
curl -s -XPOST localhost:3000/psp/callbacks -H 'Content-Type: application/json' -d "{\"pspRef\":\"$REF\",\"status\":\"completed\",\"amount\":\"100\"}"  # applied
curl -s -XPOST localhost:3000/psp/callbacks -H 'Content-Type: application/json' -d "{\"pspRef\":\"$REF\",\"status\":\"completed\",\"amount\":\"100\"}"  # duplicate, no credit
curl -s -XPOST localhost:3000/withdrawals -H 'Content-Type: application/json' -d "{\"memberId\":\"$MID\",\"amount\":\"50\"}"  # 422, 100 turnover outstanding
curl -s -XPOST localhost:3000/wallets/$WID/wagers -H 'Content-Type: application/json' -d '{"amount":"100"}'
curl -s localhost:3000/members/$MID/wallet
```
