import { Router } from 'express';
import { z } from 'zod';
import * as pspCallbackService from '../services/pspCallbackService';
import { dec, toMoneyString } from '../lib/money';
import { callbackAmount } from '../lib/validation';

export const pspCallbacksRouter = Router();

const callbackBody = z.object({
  pspRef: z.string().min(1).max(128),
  status: z.enum(['completed', 'failed']),
  amount: callbackAmount,
});

// 2xx only when the callback's intent is applied (now or earlier), so PSP retries are harmless.
// Rejections are 4xx and are already audited in psp_callback_events.
pspCallbacksRouter.post('/', async (req, res, next) => {
  try {
    const body = callbackBody.parse(req.body);
    const { deposit, outcome } = await pspCallbackService.handleCallback(body);
    switch (outcome) {
      case 'Applied':
      case 'Duplicate':
        res.status(200).json({ id: deposit.id, status: deposit.status, outcome: outcome.toLowerCase() });
        return;
      case 'AmountMismatch':
        res.status(409).json({
          error: 'amount_mismatch',
          id: deposit.id,
          status: deposit.status,
          expectedAmount: toMoneyString(dec(deposit.amount)),
          receivedAmount: toMoneyString(dec(body.amount)),
        });
        return;
      case 'InvalidTransition':
        res.status(409).json({
          error: 'invalid_transition',
          id: deposit.id,
          status: deposit.status,
          requestedStatus: body.status,
        });
        return;
    }
  } catch (err) {
    next(err);
  }
});
