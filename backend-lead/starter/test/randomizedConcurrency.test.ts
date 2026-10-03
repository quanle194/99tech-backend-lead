import { Op } from 'sequelize';
import { Response } from 'supertest';
import { FundingTx } from '../src/db/models';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createDeposit, createWallet, placeWager, requestWithdrawal, sendCallback } from './helpers/factories';
import { useServer } from './helpers/server';

useTestDb();
const app = useServer();

// Small deterministic PRNG (mulberry32) so a failing run can be replayed with SEED=<n>.
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed by default so every run is reproducible; SEED=<n> explores other interleavings.
const seed = process.env.SEED ? parseInt(process.env.SEED, 10) : 20261003;

describe('randomized concurrent money movement', () => {
  it(`keeps every wallet invariant under a random concurrent mix (seed ${seed})`, async () => {
    const random = prng(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    const amount = (maxWhole: number) => `${1 + Math.floor(random() * maxWhole)}.${String(Math.floor(random() * 100)).padStart(2, '0')}`;
    const wallets = await Promise.all(Array.from({ length: 3 }, () => createWallet()));

    for (let round = 0; round < 3; round++) {
      // Deposits are created first (their pspRef must exist), then callbacks, duplicates, conflicting
      // statuses, wrong amounts, wagers and withdrawals all race each other.
      const deposits = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const wallet = pick(wallets);
          const depositAmount = amount(200);
          const { pspRef } = await createDeposit(app(), wallet.memberId, depositAmount, Math.floor(random() * 3));
          return { pspRef, depositAmount };
        }),
      );

      const requests: Promise<Response>[] = [];
      for (let i = 0; i < 40; i++) {
        const roll = random();
        const wallet = pick(wallets);
        const deposit = pick(deposits);
        if (roll < 0.35) requests.push(sendCallback(app(), deposit.pspRef, 'completed', deposit.depositAmount));
        else if (roll < 0.4) requests.push(sendCallback(app(), deposit.pspRef, 'failed', deposit.depositAmount));
        else if (roll < 0.45) requests.push(sendCallback(app(), deposit.pspRef, 'completed', amount(200)));
        else if (roll < 0.8) requests.push(placeWager(app(), wallet.walletId, amount(60)));
        else requests.push(requestWithdrawal(app(), wallet.memberId, amount(60)));
      }
      const responses = await Promise.all(requests);

      const unexpected = responses.filter((r) => ![200, 201, 409, 422].includes(r.status));
      expect(unexpected.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
      // Exactly once: one 'applied' response per deposit that left Pending, however many deliveries raced.
      const settled = await FundingTx.count({
        where: { pspRef: { [Op.in]: deposits.map((d) => d.pspRef) }, status: { [Op.ne]: 'Pending' } },
      });
      expect(responses.filter((r) => r.body.outcome === 'applied')).toHaveLength(settled);
      for (const wallet of wallets) {
        await assertWalletInvariants(wallet.walletId);
      }
    }
  });
});
