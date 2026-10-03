import { Wallet, WalletTx } from '../db/models';
import { sequelize } from '../db/sequelize';
import { AppError } from '../lib/errors';
import { dec } from '../lib/money';
import * as walletService from './walletService';

export async function placeWager(
  walletId: string,
  amount: string,
  idempotencyKey?: string,
): Promise<{ wallet: Wallet; entry: WalletTx; replayed: boolean }> {
  return sequelize.transaction(async (t) => {
    const wallet = await walletService.lockWallet(t, { id: walletId });
    if (!wallet) {
      throw new AppError(404, 'wallet_not_found');
    }
    const previous = await walletService.findReplay(t, wallet, idempotencyKey, 'Wager', amount);
    if (previous) {
      return { wallet, entry: previous, replayed: true };
    }
    const entry = await walletService.applyEntry(t, wallet, {
      type: 'Wager',
      amount: dec(amount).negated(),
      turnoverAccruedDelta: dec(amount),
      idempotencyKey,
    });
    return { wallet, entry, replayed: false };
  });
}
