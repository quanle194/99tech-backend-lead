import { randomUUID } from 'crypto';
import { FundingTx, Wallet } from '../db/models';
import { AppError } from '../lib/errors';

// A single INSERT and no money movement: the wallet is credited only by a completed PSP callback.
// The row commits before the pspRef is returned, so a callback can never reference an uncommitted deposit.
export async function createDeposit(memberId: string, amount: string, turnoverMultiplier: number): Promise<FundingTx> {
  const wallet = await Wallet.findOne({ where: { memberId } });
  if (!wallet) {
    throw new AppError(404, 'member_not_found');
  }
  return FundingTx.create({
    memberId,
    walletId: wallet.id,
    type: 'Deposit',
    status: 'Pending',
    amount,
    turnoverMultiplier,
    pspRef: `dep_${randomUUID()}`,
  });
}
