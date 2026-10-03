import { FundingTx, PspCallbackEvent } from '../db/models';
import { FundingTxStatus } from '../db/models/fundingTx';
import { CallbackOutcome } from '../db/models/pspCallbackEvent';
import { sequelize } from '../db/sequelize';
import { AppError } from '../lib/errors';
import { dec } from '../lib/money';
import { canTransition, transition } from './fundingTxStateMachine';
import * as walletService from './walletService';

export interface PspCallback {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
}

// Rejected outcomes are returned, not thrown, so the audit row commits with them.
export async function handleCallback(callback: PspCallback): Promise<{ deposit: FundingTx; outcome: CallbackOutcome }> {
  return sequelize.transaction(async (t) => {
    // Concurrent deliveries of the same pspRef queue on this lock; each one re-reads the status
    // committed by the one before it.
    const deposit = await FundingTx.findOne({
      where: { pspRef: callback.pspRef, type: 'Deposit' },
      lock: t.LOCK.NO_KEY_UPDATE,
      transaction: t,
    });
    if (!deposit) {
      throw new AppError(404, 'unknown_psp_ref');
    }

    const target: FundingTxStatus = callback.status === 'completed' ? 'Completed' : 'Failed';
    // Fail closed: never credit an amount we did not ask for. A failed callback moves no money.
    const amountMatches = target === 'Failed' || dec(callback.amount).eq(deposit.amount);

    let outcome: CallbackOutcome;
    if (deposit.status === target) {
      outcome = amountMatches ? 'Duplicate' : 'AmountMismatch';
    } else if (!canTransition(deposit.status, target)) {
      outcome = 'InvalidTransition';
    } else if (!amountMatches) {
      outcome = 'AmountMismatch';
    } else {
      await transition(t, deposit, target);
      if (target === 'Completed') {
        const wallet = await walletService.lockWallet(t, { id: deposit.walletId });
        if (!wallet || deposit.turnoverMultiplier === null) {
          throw new Error(`Deposit ${deposit.id} violates its foreign key or type CHECK`);
        }
        const amount = dec(deposit.amount);
        await walletService.applyEntry(t, wallet, {
          type: 'Deposit',
          amount,
          fundingTxId: deposit.id,
          turnoverRequiredDelta: amount.multipliedBy(deposit.turnoverMultiplier),
        });
      }
      outcome = 'Applied';
    }

    await PspCallbackEvent.create(
      { fundingTxId: deposit.id, status: callback.status, amount: callback.amount, outcome },
      { transaction: t },
    );
    return { deposit, outcome };
  });
}
