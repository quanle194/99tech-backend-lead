import { Router } from 'express';
import { z } from 'zod';
import * as depositService from '../services/depositService';
import { dec, toMoneyString } from '../lib/money';
import { moneyString, uuid } from '../lib/validation';

export const depositsRouter = Router();

const createDepositBody = z.object({
  memberId: uuid,
  amount: moneyString,
  // Upper bound keeps amount x multiplier far inside DECIMAL(36,18).
  turnoverMultiplier: z.number().int().min(0).max(100).default(1),
});

depositsRouter.post('/', async (req, res, next) => {
  try {
    const body = createDepositBody.parse(req.body);
    const deposit = await depositService.createDeposit(body.memberId, body.amount, body.turnoverMultiplier);
    res.status(201).json({
      id: deposit.id,
      pspRef: deposit.pspRef,
      status: deposit.status,
      amount: toMoneyString(dec(deposit.amount)),
      turnoverMultiplier: deposit.turnoverMultiplier,
    });
  } catch (err) {
    next(err);
  }
});
