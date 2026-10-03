import { Transaction, WhereOptions } from 'sequelize';
import { Wallet, WalletTx } from '../db/models';
import { WalletTxType } from '../db/models/walletTx';
import { AppError } from '../lib/errors';
import { BigNumber, dec, toMoneyString, ZERO } from '../lib/money';

// The wallet row is the mutex for every change to its balance and turnover counters.
// Lock order across the codebase: funding tx first, then wallet. NO KEY UPDATE still serialises
// writers but does not block the KEY SHARE lock that inserting a deposit takes through its FK.
export function lockWallet(t: Transaction, where: WhereOptions<Wallet>): Promise<Wallet | null> {
  return Wallet.findOne({ where, lock: t.LOCK.NO_KEY_UPDATE, transaction: t });
}

export interface LedgerEntry {
  type: WalletTxType;
  amount: BigNumber; // signed: credit > 0, debit < 0
  fundingTxId?: string;
  turnoverRequiredDelta?: BigNumber;
  turnoverAccruedDelta?: BigNumber;
}

// The only code path that changes a balance or turnover, always together with its ledger entry.
// Callers must hold the wallet lock in `t`: the balance check is only correct under it.
export async function applyEntry(t: Transaction, wallet: Wallet, entry: LedgerEntry): Promise<WalletTx> {
  const balance = dec(wallet.balance).plus(entry.amount);
  if (balance.lt(0)) {
    throw new AppError(422, 'insufficient_funds', {
      balance: toMoneyString(dec(wallet.balance)),
      amount: toMoneyString(entry.amount.abs()),
    });
  }
  const turnoverRequired = toMoneyString(dec(wallet.turnoverRequired).plus(entry.turnoverRequiredDelta ?? ZERO));
  const turnoverAccrued = toMoneyString(dec(wallet.turnoverAccrued).plus(entry.turnoverAccruedDelta ?? ZERO));
  await wallet.update({ balance: toMoneyString(balance), turnoverRequired, turnoverAccrued }, { transaction: t });
  return WalletTx.create(
    {
      walletId: wallet.id,
      type: entry.type,
      amount: toMoneyString(entry.amount),
      balanceAfter: toMoneyString(balance),
      turnoverRequiredAfter: turnoverRequired,
      turnoverAccruedAfter: turnoverAccrued,
      fundingTxId: entry.fundingTxId ?? null,
    },
    { transaction: t },
  );
}

