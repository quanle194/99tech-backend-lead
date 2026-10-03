import { FundingTx, Wallet } from '../db/models';
import { sequelize } from '../db/sequelize';
import { AppError } from '../lib/errors';
import { BigNumber, dec, toMoneyString, ZERO } from '../lib/money';
import * as walletService from './walletService';

export async function requestWithdrawal(
  memberId: string,
  amount: string,
  idempotencyKey?: string,
): Promise<{ withdrawal: FundingTx; wallet: Wallet; replayed: boolean }> {
  return sequelize.transaction(async (t) => {
    const wallet = await walletService.lockWallet(t, { memberId });
    if (!wallet) {
      throw new AppError(404, 'member_not_found');
    }

    // A retry returns the original withdrawal; it is not re-checked against today's turnover or balance.
    const previous = await walletService.findReplay(t, wallet, idempotencyKey, 'Withdrawal', amount);
    if (previous) {
      const withdrawal = await FundingTx.findOne({
        where: { id: previous.fundingTxId },
        rejectOnEmpty: true,
        transaction: t,
      });
      return { withdrawal, wallet, replayed: true };
    }

    // The anti-abuse rule is checked before the balance: it is the reason the client must act on first.
    const outstanding = BigNumber.max(ZERO, dec(wallet.turnoverRequired).minus(wallet.turnoverAccrued));
    if (outstanding.gt(0)) {
      throw new AppError(422, 'turnover_requirement_not_met', {
        turnoverRequired: wallet.turnoverRequired,
        turnoverAccrued: wallet.turnoverAccrued,
        turnoverOutstanding: toMoneyString(outstanding),
      });
    }

    // Money leaves the wallet now; approval happens later on the Pending funding transaction.
    const withdrawal = await FundingTx.create(
      { memberId, walletId: wallet.id, type: 'Withdrawal', status: 'Pending', amount },
      { transaction: t },
    );
    await walletService.applyEntry(t, wallet, {
      type: 'Withdrawal',
      amount: dec(amount).negated(),
      fundingTxId: withdrawal.id,
      idempotencyKey,
    });
    return { withdrawal, wallet, replayed: false };
  });
}
