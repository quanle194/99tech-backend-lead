import { randomUUID } from 'crypto';
import { FundingTx, Wallet, WalletTx } from '../src/db/models';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createDeposit, createWallet, fundWallet, placeWager, requestWithdrawal, sendCallback } from './helpers/factories';
import { useServer } from './helpers/server';

useTestDb();
const app = useServer();

describe('POST /withdrawals', () => {
  it('turnover lock blocks a withdrawal with the outstanding amount, then unblocks once wagered', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100', 1); // requires 100 of turnover
    await fundWallet(app(), memberId, '100', 0); // spendable money without extra requirement

    const blocked = await requestWithdrawal(app(), memberId, '50');
    expect(blocked.status).toBe(422);
    expect(blocked.body).toEqual({
      error: 'turnover_requirement_not_met',
      turnoverRequired: '100.000000000000000000',
      turnoverAccrued: '0.000000000000000000',
      turnoverOutstanding: '100.000000000000000000',
    });

    await placeWager(app(), walletId, '99.999999999999999999');
    const oneUnitShort = await requestWithdrawal(app(), memberId, '50');
    expect(oneUnitShort.status).toBe(422);
    expect(oneUnitShort.body.turnoverOutstanding).toBe('0.000000000000000001');

    await placeWager(app(), walletId, '0.000000000000000001'); // accrued == required unblocks
    const allowed = await requestWithdrawal(app(), memberId, '50');
    expect(allowed.status).toBe(201);
    expect(allowed.body).toEqual({
      id: expect.any(String),
      status: 'Pending',
      amount: '50.000000000000000000',
      balance: '50.000000000000000000',
    });
    expect(await FundingTx.count({ where: { memberId, type: 'Withdrawal' } })).toBe(1);
    await assertWalletInvariants(walletId);
  });

  it('debits immediately, with a pending withdrawal and a linked ledger entry', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100', 0);

    const res = await requestWithdrawal(app(), memberId, '30.5');

    expect(res.status).toBe(201);
    const withdrawal = await FundingTx.findByPk(res.body.id);
    expect(withdrawal!.status).toBe('Pending');
    expect(withdrawal!.walletId).toBe(walletId);
    const entry = await WalletTx.findOne({ where: { fundingTxId: res.body.id } });
    expect(entry!.type).toBe('Withdrawal');
    expect(entry!.amount).toBe('-30.500000000000000000');
    expect((await Wallet.findByPk(walletId))!.balance).toBe('69.500000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('a deposit with turnoverMultiplier 0 can be withdrawn without wagering', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100', 0);

    const res = await requestWithdrawal(app(), memberId, '100');

    expect(res.status).toBe(201);
    expect(res.body.balance).toBe('0.000000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('rejects a withdrawal above the balance with 422 and creates no withdrawal', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100', 0);

    const res = await requestWithdrawal(app(), memberId, '100.01');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect(await FundingTx.count({ where: { type: 'Withdrawal' } })).toBe(0);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('100.000000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('20 concurrent withdrawals cannot overdraw the wallet', async () => {
    const { memberId, walletId } = await createWallet();
    await fundWallet(app(), memberId, '100', 0);

    const responses = await Promise.all(Array.from({ length: 20 }, () => requestWithdrawal(app(), memberId, '10')));

    expect(responses.map((r) => r.status).sort()).toEqual([...Array(10).fill(201), ...Array(10).fill(422)]);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('0.000000000000000000');
    expect(await FundingTx.count({ where: { walletId, type: 'Withdrawal' } })).toBe(10);
    await assertWalletInvariants(walletId);
  });

  it('a withdrawal concurrent with a deposit completion sees either all or none of the new requirement', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet()));
    const pending = await Promise.all(
      wallets.map(async ({ memberId }) => {
        await fundWallet(app(), memberId, '100', 0);
        return createDeposit(app(), memberId, '100', 1);
      }),
    );

    const results = await Promise.all(
      wallets.map(({ memberId }, i) =>
        Promise.all([requestWithdrawal(app(), memberId, '50'), sendCallback(app(), pending[i].pspRef, 'completed', '100')]),
      ),
    );

    for (const [i, [withdrawal, callback]] of results.entries()) {
      expect(callback.status).toBe(200);
      const wallet = await Wallet.findByPk(wallets[i].walletId);
      if (withdrawal.status === 201) {
        expect(wallet!.balance).toBe('150.000000000000000000'); // withdrew before the requirement landed
      } else {
        expect(withdrawal.status).toBe(422);
        expect(withdrawal.body.turnoverOutstanding).toBe('100.000000000000000000');
        expect(wallet!.balance).toBe('200.000000000000000000');
      }
      await assertWalletInvariants(wallets[i].walletId);
    }
  });

  it('returns 404 for an unknown member', async () => {
    const res = await requestWithdrawal(app(), randomUUID(), '10');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('member_not_found');
  });
});
