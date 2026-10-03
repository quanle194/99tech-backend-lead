import { createHmac } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { PspCallbackEvent, Wallet } from '../src/db/models';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createDeposit, createWallet } from './helpers/factories';

useTestDb();
const secret = 'test-webhook-secret';
const app = createApp({ pspWebhookSecret: secret });

function post(body: string, signature?: string) {
  const req = request(app).post('/psp/callbacks').set('Content-Type', 'application/json');
  return (signature ? req.set('X-Psp-Signature', signature) : req).send(body);
}

const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('PSP callback signatures', () => {
  it('without a configured secret, unsigned callbacks are refused unless explicitly allowed', async () => {
    const { memberId, walletId } = await createWallet();
    const { pspRef } = await createDeposit(app, memberId, '100');
    const body = JSON.stringify({ pspRef, status: 'completed', amount: '100' });

    const res = await request(createApp({})).post('/psp/callbacks').set('Content-Type', 'application/json').send(body);

    expect(res.status).toBe(401);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('0.000000000000000000');
  });

  it('a player holding the pspRef cannot complete their own deposit without the signature', async () => {
    const { memberId, walletId } = await createWallet();
    const { pspRef } = await createDeposit(app, memberId, '100');
    const body = JSON.stringify({ pspRef, status: 'completed', amount: '100' });

    const unsigned = await post(body);
    const forged = await post(body, sign(body.replace('100', '999')));

    expect(unsigned.status).toBe(401);
    expect(unsigned.body).toEqual({ error: 'invalid_signature' });
    expect(forged.status).toBe(401);
    expect((await Wallet.findByPk(walletId))!.balance).toBe('0.000000000000000000');
    expect(await PspCallbackEvent.count()).toBe(0);
  });

  it('a correctly signed callback is applied', async () => {
    const { memberId, walletId } = await createWallet();
    const { pspRef } = await createDeposit(app, memberId, '100');
    const body = JSON.stringify({ pspRef, status: 'completed', amount: '100' });

    const res = await post(body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('applied');
    expect((await Wallet.findByPk(walletId))!.balance).toBe('100.000000000000000000');
    await assertWalletInvariants(walletId);
  });
});
