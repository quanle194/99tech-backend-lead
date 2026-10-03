import { Router } from 'express';
import { z } from 'zod';
import * as withdrawalService from '../services/withdrawalService';
import { dec, toMoneyString } from '../lib/money';
import { moneyString, uuid } from '../lib/validation';

export const withdrawalsRouter = Router();

const createWithdrawalBody = z.object({
  memberId: uuid,
  amount: moneyString,
});

withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = createWithdrawalBody.parse(req.body);
    const { withdrawal, wallet } = await withdrawalService.requestWithdrawal(body.memberId, body.amount);
    res.status(201).json({
      id: withdrawal.id,
      status: withdrawal.status,
      amount: toMoneyString(dec(withdrawal.amount)),
      balance: wallet.balance,
    });
  } catch (err) {
    next(err);
  }
});
