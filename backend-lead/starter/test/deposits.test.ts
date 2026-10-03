import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { FundingTx, Wallet, WalletTx } from '../src/db/models';
import { sequelize } from '../src/db/sequelize';
import { assertWalletInvariants, useTestDb } from './helpers/db';
import { createWallet } from './helpers/factories';

useTestDb();
const app = createApp();

describe('POST /deposits', () => {
  it('creates a pending deposit with a pspRef and moves no money', async () => {
    const { memberId, walletId } = await createWallet();

    const res = await request(app).post('/deposits').send({ memberId, amount: '100.50', turnoverMultiplier: 3 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      pspRef: expect.any(String),
      status: 'Pending',
      amount: '100.500000000000000000',
      turnoverMultiplier: 3,
    });
    const wallet = await Wallet.findByPk(walletId);
    expect(wallet!.balance).toBe('0.000000000000000000');
    expect(wallet!.turnoverRequired).toBe('0.000000000000000000');
    expect(await WalletTx.count()).toBe(0);
    await assertWalletInvariants(walletId);
  });

  it('defaults turnoverMultiplier to 1 and issues a distinct pspRef per deposit', async () => {
    const { memberId } = await createWallet();

    const first = await request(app).post('/deposits').send({ memberId, amount: '10' });
    const second = await request(app).post('/deposits').send({ memberId, amount: '10' });

    expect(first.body.turnoverMultiplier).toBe(1);
    expect(first.body.pspRef).not.toBe(second.body.pspRef);
    expect(await FundingTx.count({ where: { memberId, status: 'Pending' } })).toBe(2);
  });

  it('is not blocked by a wager or withdrawal holding the wallet lock', async () => {
    const { memberId, walletId } = await createWallet();
    const holder = await sequelize.transaction();
    try {
      await Wallet.findOne({ where: { id: walletId }, lock: holder.LOCK.NO_KEY_UPDATE, transaction: holder });

      const res = await request(app).post('/deposits').send({ memberId, amount: '10' });

      expect(res.status).toBe(201);
    } finally {
      await holder.rollback();
    }
  });

  it('returns 404 for an unknown member', async () => {
    const res = await request(app).post('/deposits').send({ memberId: randomUUID(), amount: '10' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('member_not_found');
  });

  it.each([
    ['amount as a JSON number', { amount: 100.5 }],
    ['negative amount', { amount: '-5' }],
    ['zero amount', { amount: '0' }],
    ['amount with 19 decimals', { amount: '1.0000000000000000001' }],
    ['fractional multiplier', { amount: '10', turnoverMultiplier: 1.5 }],
    ['negative multiplier', { amount: '10', turnoverMultiplier: -1 }],
    ['multiplier above the cap', { amount: '10', turnoverMultiplier: 101 }],
  ])('rejects %s with 400 and writes nothing', async (_label, overrides) => {
    const { memberId } = await createWallet();
    const res = await request(app).post('/deposits').send({ memberId, ...overrides });
    expect(res.status).toBe(400);
    expect(await FundingTx.count()).toBe(0);
  });

  it('rejects a malformed memberId with 400 before it reaches the database', async () => {
    const res = await request(app).post('/deposits').send({ memberId: 'not-a-uuid', amount: '10' });
    expect(res.status).toBe(400);
  });
});
