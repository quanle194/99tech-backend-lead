import BigNumber from 'bignumber.js';
import { Transaction, WhereOptions } from 'sequelize';
import { Wallet, WalletTx } from '../db/models';
import { WalletTxType } from '../db/models/walletTx';
import { AppError } from '../lib/errors';
import { dec, toMoneyString, ZERO } from '../lib/money';

// The wallet row is the mutex for every change to its balance or turnover counters.
// Lock order across the codebase: funding tx first, then wallet. Keep transactions short:
// no I/O outside the database while a lock is held.
export function lockWallet(t: Transaction, where: WhereOptions<Wallet>): Promise<Wallet | null> {
  return Wallet.findOne({ where, lock: t.LOCK.UPDATE, transaction: t });
}

export interface LedgerEntry {
  type: WalletTxType;
  amount: BigNumber; // signed: credit > 0, debit < 0
  fundingTxId?: string;
  turnoverRequiredDelta?: BigNumber;
  turnoverAccruedDelta?: BigNumber;
}

// The only code path that changes a wallet balance. It always writes the ledger entry in the same
// transaction, so balance == SUM(wallet_txs.amount) cannot drift. Callers must hold the wallet lock
// (lockWallet) in `t`; the balance check below is only correct under that lock.
export async function applyEntry(t: Transaction, wallet: Wallet, entry: LedgerEntry): Promise<WalletTx> {
  const balance = dec(wallet.balance).plus(entry.amount);
  if (balance.lt(0)) {
    throw new AppError(422, 'insufficient_funds', {
      balance: toMoneyString(dec(wallet.balance)),
      amount: toMoneyString(entry.amount.abs()),
    });
  }
  await wallet.update(
    {
      balance: toMoneyString(balance),
      turnoverRequired: toMoneyString(dec(wallet.turnoverRequired).plus(entry.turnoverRequiredDelta ?? ZERO)),
      turnoverAccrued: toMoneyString(dec(wallet.turnoverAccrued).plus(entry.turnoverAccruedDelta ?? ZERO)),
    },
    { transaction: t },
  );
  return WalletTx.create(
    {
      walletId: wallet.id,
      type: entry.type,
      amount: toMoneyString(entry.amount),
      balanceAfter: toMoneyString(balance),
      fundingTxId: entry.fundingTxId ?? null,
    },
    { transaction: t },
  );
}
