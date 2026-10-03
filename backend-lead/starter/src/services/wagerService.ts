import { Wallet, WalletTx } from '../db/models';
import { sequelize } from '../db/sequelize';
import { AppError } from '../lib/errors';
import { dec } from '../lib/money';
import * as walletService from './walletService';

// The wallet lock serialises concurrent wagers, so the balance check inside applyEntry
// always sees the balance left by the previous wager.
export async function placeWager(walletId: string, amount: string): Promise<{ wallet: Wallet; entry: WalletTx }> {
  return sequelize.transaction(async (t) => {
    const wallet = await walletService.lockWallet(t, { id: walletId });
    if (!wallet) {
      throw new AppError(404, 'wallet_not_found');
    }
    const entry = await walletService.applyEntry(t, wallet, {
      type: 'Wager',
      amount: dec(amount).negated(),
      turnoverAccruedDelta: dec(amount),
    });
    return { wallet, entry };
  });
}
