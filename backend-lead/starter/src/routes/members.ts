import { Router } from 'express';
import { z } from 'zod';
import * as memberService from '../services/memberService';
import { uuid } from '../lib/validation';

export const membersRouter = Router();

const createMemberBody = z.object({
  username: z.string().min(3).max(64),
});

membersRouter.post('/', async (req, res, next) => {
  try {
    const body = createMemberBody.parse(req.body);
    const { member, wallet } = await memberService.createMember(body.username);
    res.status(201).json({
      member: { id: member.id, username: member.username },
      wallet: { id: wallet.id, balance: wallet.balance },
    });
  } catch (err) {
    next(err);
  }
});

membersRouter.get('/:memberId/wallet', async (req, res, next) => {
  try {
    const memberId = uuid.parse(req.params.memberId);
    const wallet = await memberService.getWalletByMemberId(memberId);
    if (!wallet) {
      res.status(404).json({ error: 'wallet not found' });
      return;
    }
    res.json({ id: wallet.id, memberId: wallet.memberId, balance: wallet.balance });
  } catch (err) {
    next(err);
  }
});
