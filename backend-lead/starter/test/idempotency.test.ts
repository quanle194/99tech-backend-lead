import { FundingTx, Wallet, WalletTx } from '../src/db/models';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createWallet, fundWallet, placeWager, requestWithdrawal } from './helpers/factories';
import { useServer } from './helpers/server';

useTestDb();
const app = useServer();

describe('Idempotency-Key on debits', () => {
  it('a retried wager with the same key debits once and returns the original entry', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100');

    const first = await placeWager(app(), walletId, '10', 'wager-1');
    const retry = await placeWager(app(), walletId, '10', 'wager-1');

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('90.000000000000000000');
    expect(await WalletTx.count({ where: { walletId, type: 'Wager' } })).toBe(1);
    await assertWalletInvariants(walletId);
  });

  it('20 concurrent retries of one wager key debit exactly once and none fail', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100');

    const responses = await Promise.all(Array.from({ length: 20 }, () => placeWager(app(), walletId, '10', 'wager-x')));

    expect(responses.map((r) => r.status).sort()).toEqual([...Array(19).fill(200), 201]);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('90.000000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('a retried withdrawal with the same key debits once and returns the same withdrawal', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100', 0);

    const first = await requestWithdrawal(app(), memberId, '30', 'wd-1');
    const retry = await requestWithdrawal(app(), memberId, '30', 'wd-1');

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('70.000000000000000000');
    expect(await FundingTx.count({ where: { walletId, type: 'Withdrawal' } })).toBe(1);
    await assertWalletInvariants(walletId);
  });

  it('reusing a key for a different request is refused with 409 and moves no money', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100', 0);
    await placeWager(app(), walletId, '10', 'key-1');

    const differentAmount = await placeWager(app(), walletId, '11', 'key-1');
    const differentType = await requestWithdrawal(app(), memberId, '10', 'key-1');

    expect(differentAmount.status).toBe(409);
    expect(differentAmount.body).toEqual({ error: 'idempotency_key_reused', idempotencyKey: 'key-1' });
    expect(differentType.status).toBe(409);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('90.000000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('requests without a key keep the contract from the brief: each one is a new debit', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100');

    await placeWager(app(), walletId, '10');
    await placeWager(app(), walletId, '10');

    expect((await Wallet.findByPk(walletId))!.balance).toBe('80.000000000000000000');
    await assertWalletInvariants(walletId);
  });
});
