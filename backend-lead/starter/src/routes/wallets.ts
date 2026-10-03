import { Router } from 'express';
import { z } from 'zod';
import * as wagerService from '../services/wagerService';
import { dec, toMoneyString } from '../lib/money';
import { idempotencyKey, moneyString, uuid } from '../lib/validation';

export const walletsRouter = Router();

const wagerParams = z.object({ walletId: uuid });
const wagerBody = z.object({ amount: moneyString });

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const { walletId } = wagerParams.parse(req.params);
    const body = wagerBody.parse(req.body);
    const key = idempotencyKey.parse(req.get('Idempotency-Key'));
    const { wallet, entry, replayed } = await wagerService.placeWager(walletId, body.amount, key);
    // A replay returns the original entry with the wallet's current state.
    res.status(replayed ? 200 : 201).json({
      id: entry.id,
      walletId: wallet.id,
      amount: toMoneyString(dec(body.amount)),
      balance: wallet.balance,
      turnoverAccrued: wallet.turnoverAccrued,
    });
  } catch (err) {
    next(err);
  }
});
