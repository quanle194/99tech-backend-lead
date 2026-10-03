import { Router } from 'express';
import { z } from 'zod';
import * as withdrawalService from '../services/withdrawalService';
import { dec, toMoneyString } from '../lib/money';
import { idempotencyKey, moneyString, uuid } from '../lib/validation';

export const withdrawalsRouter = Router();

const createWithdrawalBody = z.object({
  memberId: uuid,
  amount: moneyString,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = createWithdrawalBody.parse(req.body);
    const key = idempotencyKey.parse(req.get('Idempotency-Key'));
    const { withdrawal, wallet, replayed } = await withdrawalService.requestWithdrawal(body.memberId, body.amount, key);
    res.status(replayed ? 200 : 201).json({
      id: withdrawal.id,
      status: withdrawal.status,
      amount: toMoneyString(dec(withdrawal.amount)),
      balance: wallet.balance,
    });
  } catch (err) {
    next(err);
  }
});
