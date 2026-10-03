import { randomUUID } from 'crypto';
import { Wallet, WalletTx } from '../src/db/models';
import { sequelize } from '../src/db/sequelize';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createWallet, fundWallet, placeWager } from './helpers/factories';
import { useServer } from './helpers/server';

useTestDb();
const app = useServer();

describe('POST /wallets/:walletId/wagers', () => {
  it('debits the wallet, writes a ledger entry and accrues turnover', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100');

    const res = await placeWager(app(), walletId, '10.25');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      walletId,
      amount: '10.250000000000000000',
      balance: '89.750000000000000000',
      turnoverAccrued: '10.250000000000000000',
    });
    const entry = await WalletTx.findByPk(res.body.id);
    expect(entry!.type).toBe('Wager');
    expect(entry!.amount).toBe('-10.250000000000000000');
    expect(entry!.balanceAfter).toBe('89.750000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('rejects a wager larger than the balance with 422 and changes nothing', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '10');

    const res = await placeWager(app(), walletId, '10.000000000000000001');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: 'insufficient_funds',
      balance: '10.000000000000000000',
      amount: '10.000000000000000001',
    });
    const wallet = await Wallet.findByPk(walletId);
    expect(wallet!.balance).toBe('10.000000000000000000');
    expect(wallet!.turnoverAccrued).toBe('0.000000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('20 concurrent wagers cannot overdraw the wallet', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100');

    const responses = await Promise.all(Array.from({ length: 20 }, () => placeWager(app(), walletId, '10')));

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([...Array(10).fill(201), ...Array(10).fill(422)]);
    const wallet = await Wallet.findByPk(walletId);
    expect(wallet!.balance).toBe('0.000000000000000000');
    expect(wallet!.turnoverAccrued).toBe('100.000000000000000000');
    expect(await WalletTx.count({ where: { walletId, type: 'Wager' } })).toBe(10);
    await assertWalletInvariants(walletId);
  });

  it('a wager stuck behind a held wallet lock gets a retryable 503 and moves no money', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100');
    const holder = await sequelize.transaction();
    try {
      await Wallet.findOne({ where: { id: walletId }, lock: holder.LOCK.NO_KEY_UPDATE, transaction: holder });

      const res = await placeWager(app(), walletId, '10');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lock_timeout', retryable: true });
    } finally {
      await holder.rollback();
    }
    expect((await Wallet.findByPk(walletId))!.balance).toBe('100.000000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('returns 404 for an unknown wallet and 400 for a malformed wallet id', async () => {
    const unknown = await placeWager(app(), randomUUID(), '10');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('wallet_not_found');

    const malformed = await placeWager(app(), 'not-a-uuid', '10');
    expect(malformed.status).toBe(400);
  });
});
