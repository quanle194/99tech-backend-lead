import { Transaction } from 'sequelize';
import { FundingTx } from '../db/models';
import { FundingTxStatus } from '../db/models/fundingTx';

// Terminal states have no exits. Withdrawal approval/rejection would reuse the same table.
const TRANSITIONS: Record<FundingTxStatus, readonly FundingTxStatus[]> = {
  Pending: ['Completed', 'Failed'],
  Completed: [],
  Failed: [],
};

export function canTransition(from: FundingTxStatus, to: FundingTxStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// The conditional UPDATE is a second guard behind the row lock: if a future caller forgets the lock,
// a concurrent transition matches zero rows and this throws instead of applying twice.
export async function transition(t: Transaction, fundingTx: FundingTx, to: FundingTxStatus): Promise<void> {
  const from = fundingTx.status;
  if (!canTransition(from, to)) {
    throw new Error(`Invalid funding transaction transition ${from} -> ${to} for ${fundingTx.id}`);
  }
  const settledAt = new Date();
  const [updated] = await FundingTx.update(
    { status: to, settledAt },
    { where: { id: fundingTx.id, status: from }, transaction: t },
  );
  if (updated !== 1) {
    throw new Error(`Funding transaction ${fundingTx.id} is no longer ${from}`);
  }
  fundingTx.set({ status: to, settledAt });
}
