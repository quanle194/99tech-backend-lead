import request from 'supertest';
import { FundingTx, PspCallbackEvent, Wallet, WalletTx } from '../src/db/models';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createDeposit, createWallet, sendCallback } from './helpers/factories';
import { useServer } from './helpers/server';

useTestDb();
const app = useServer();

async function walletState(walletId: string) {
  const wallet = await Wallet.findByPk(walletId);
  return {
    balance: wallet!.balance,
    turnoverRequired: wallet!.turnoverRequired,
    entries: await WalletTx.count({ where: { walletId } }),
  };
}

async function outcomes(fundingTxId: string): Promise<string[]> {
  const events = await PspCallbackEvent.findAll({ where: { fundingTxId }, order: [['id', 'ASC']] });
  return events.map((e) => e.outcome);
}

describe('POST /psp/callbacks', () => {
  it('credits a completed deposit once, with a ledger entry and its turnover requirement', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100.50', 2);

    const res = await sendCallback(app(), pspRef, 'completed', '100.50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, status: 'Completed', outcome: 'applied' });
    expect(await walletState(walletId)).toEqual({
      balance: '100.500000000000000000',
      turnoverRequired: '201.000000000000000000',
      entries: 1,
    });
    expect((await FundingTx.findByPk(id))!.settledAt).not.toBeNull();
    await assertWalletInvariants(walletId);
  });

  it('a duplicate callback delivered twice in sequence credits only once', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100');

    const first = await sendCallback(app(), pspRef, 'completed', '100');
    const second = await sendCallback(app(), pspRef, 'completed', '100');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ id, status: 'Completed', outcome: 'duplicate' });
    expect(await walletState(walletId)).toEqual({
      balance: '100.000000000000000000',
      turnoverRequired: '100.000000000000000000',
      entries: 1,
    });
    expect(await outcomes(id)).toEqual(['Applied', 'Duplicate']);
    await assertWalletInvariants(walletId);
  });

  it('20 concurrent duplicate callbacks credit exactly once and all get 200', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100');

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => sendCallback(app(), pspRef, 'completed', '100')),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(responses.filter((r) => r.body.outcome === 'applied')).toHaveLength(1);
    expect(await walletState(walletId)).toEqual({
      balance: '100.000000000000000000',
      turnoverRequired: '100.000000000000000000',
      entries: 1,
    });
    const recorded = await outcomes(id);
    expect(recorded.filter((o) => o === 'Applied')).toHaveLength(1);
    expect(recorded.filter((o) => o === 'Duplicate')).toHaveLength(19);
    await assertWalletInvariants(walletId);
  });

  it('concurrent completed and failed callbacks: exactly one wins and the other is rejected', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100');

    const statuses = Array.from({ length: 20 }, (_, i): 'completed' | 'failed' => (i % 2 === 0 ? 'completed' : 'failed'));
    const responses = await Promise.all(statuses.map((s) => sendCallback(app(), pspRef, s, '100')));

    const deposit = await FundingTx.findByPk(id);
    const winner = deposit!.status === 'Completed' ? 'completed' : 'failed';
    responses.forEach((res, i) => {
      expect(res.status).toBe(statuses[i] === winner ? 200 : 409);
    });
    expect(responses.filter((r) => r.body.outcome === 'applied')).toHaveLength(1);
    expect((await walletState(walletId)).entries).toBe(winner === 'completed' ? 1 : 0);
    await assertWalletInvariants(walletId);
  });

  it('a failed callback moves no money and a later completed callback is rejected', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100');

    const failed = await sendCallback(app(), pspRef, 'failed', '100');
    const lateCompleted = await sendCallback(app(), pspRef, 'completed', '100');

    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ id, status: 'Failed', outcome: 'applied' });
    expect(lateCompleted.status).toBe(409);
    expect(lateCompleted.body).toEqual({ error: 'invalid_transition', id, status: 'Failed', requestedStatus: 'completed' });
    expect(await walletState(walletId)).toEqual({
      balance: '0.000000000000000000',
      turnoverRequired: '0.000000000000000000',
      entries: 0,
    });
    expect(await outcomes(id)).toEqual(['Applied', 'InvalidTransition']);
    await assertWalletInvariants(walletId);
  });

  it('a failed callback after completion is rejected and the credited money stays', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100');
    await sendCallback(app(), pspRef, 'completed', '100');

    const res = await sendCallback(app(), pspRef, 'failed', '100');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_transition');
    expect((await FundingTx.findByPk(id))!.status).toBe('Completed');
    expect((await walletState(walletId)).balance).toBe('100.000000000000000000');
    await assertWalletInvariants(walletId);
  });

  it('an amount mismatch is rejected, audited and leaves the deposit pending for a correct retry', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100');

    const mismatch = await sendCallback(app(), pspRef, 'completed', '10000');

    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toEqual({
      error: 'amount_mismatch',
      id,
      status: 'Pending',
      expectedAmount: '100.000000000000000000',
      receivedAmount: '10000.000000000000000000',
    });
    expect((await walletState(walletId)).entries).toBe(0);

    const retry = await sendCallback(app(), pspRef, 'completed', '100.000');
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('applied');
    expect((await walletState(walletId)).balance).toBe('100.000000000000000000');
    expect(await outcomes(id)).toEqual(['AmountMismatch', 'Applied']);
    await assertWalletInvariants(walletId);
  });

  it('a duplicate completed callback with a different amount is rejected and changes nothing', async () => {
    const { memberId, walletId } = await createWallet();
    const { id, pspRef } = await createDeposit(app(), memberId, '100');
    await sendCallback(app(), pspRef, 'completed', '100');

    const res = await sendCallback(app(), pspRef, 'completed', '99.99');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('amount_mismatch');
    expect(await walletState(walletId)).toEqual({
      balance: '100.000000000000000000',
      turnoverRequired: '100.000000000000000000',
      entries: 1,
    });
    expect(await outcomes(id)).toEqual(['Applied', 'AmountMismatch']);
    await assertWalletInvariants(walletId);
  });

  it('returns 404 for an unknown pspRef and records nothing', async () => {
    const res = await sendCallback(app(), 'dep_does-not-exist', 'completed', '100');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_psp_ref');
    expect(await PspCallbackEvent.count()).toBe(0);
  });

  it.each([
    ['an unknown status', { status: 'success', amount: '100' }],
    ['a numeric amount', { status: 'completed', amount: 100 }],
    ['a missing amount', { status: 'completed' }],
  ])('rejects a callback with %s as 400', async (_label, body) => {
    const { memberId } = await createWallet();
    const { pspRef } = await createDeposit(app(), memberId, '100');

    const res = await request(app()).post('/psp/callbacks').send({ pspRef, ...body });

    expect(res.status).toBe(400);
    expect(await PspCallbackEvent.count()).toBe(0);
  });
});
