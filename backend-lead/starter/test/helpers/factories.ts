import { randomUUID } from 'crypto';
import request from 'supertest';
import * as memberService from '../../src/services/memberService';

export async function createWallet(): Promise<{ memberId: string; walletId: string }> {
  const { member, wallet } = await memberService.createMember(`m-${randomUUID().slice(0, 12)}`);
  return { memberId: member.id, walletId: wallet.id };
}

type App = Parameters<typeof request>[0];

export async function createDeposit(
  app: App,
  memberId: string,
  amount: string,
  turnoverMultiplier = 1,
): Promise<{ id: string; pspRef: string }> {
  const res = await request(app).post('/deposits').send({ memberId, amount, turnoverMultiplier });
  expect(res.status).toBe(201);
  return res.body;
}

export function sendCallback(app: App, pspRef: string, status: 'completed' | 'failed', amount: string) {
  return request(app).post('/psp/callbacks').send({ pspRef, status, amount });
}

// Deposit + completed callback: puts real, ledgered money in a wallet.
export async function fundWallet(app: App, memberId: string, amount: string, turnoverMultiplier = 1): Promise<string> {
  const { id, pspRef } = await createDeposit(app, memberId, amount, turnoverMultiplier);
  const res = await sendCallback(app, pspRef, 'completed', amount);
  expect(res.status).toBe(200);
  return id;
}

export function placeWager(app: App, walletId: string, amount: string, idempotencyKey?: string) {
  const req = request(app).post(`/wallets/${walletId}/wagers`);
  return (idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req).send({ amount });
}

export function requestWithdrawal(app: App, memberId: string, amount: string, idempotencyKey?: string) {
  const req = request(app).post('/withdrawals');
  return (idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req).send({ memberId, amount });
}
