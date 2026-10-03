import { randomUUID } from 'crypto';
import { Wallet, WalletTx } from '../src/db/models';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createDeposit, createWallet, fundWallet, placeWager, sendCallback } from './helpers/factories';
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

  it('a late duplicate callback after the balance moved changes nothing', async () => {
    const { memberId, walletId } = await createWallet();
    const { pspRef } = await createDeposit(app(), memberId, '100');
    await sendCallback(app(), pspRef, 'completed', '100');
    await placeWager(app(), walletId, '40');

    const late = await sendCallback(app(), pspRef, 'completed', '100');

    expect(late.status).toBe(200);
    expect(late.body.outcome).toBe('duplicate');
    const wallet = await Wallet.findByPk(walletId);
    expect(wallet!.balance).toBe('60.000000000000000000');
    expect(await WalletTx.count({ where: { walletId } })).toBe(2);
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
