import { randomUUID } from 'crypto';
import { sequelize } from '../src/db/sequelize';
import { createWallet } from './helpers/factories';
import { useTestDb } from './helpers/db';

useTestDb();

// These bypass the services on purpose: they prove the database itself refuses to break an
// invariant, whatever a future code path does.
async function seedDepositEntry() {
  const { memberId, walletId } = await createWallet();
  const fundingTxId = randomUUID();
  await sequelize.query(
    `INSERT INTO funding_txs (id, member_id, wallet_id, type, status, amount, turnover_multiplier, psp_ref)
     VALUES (:fundingTxId, :memberId, :walletId, 'Deposit', 'Completed', 10, 1, :pspRef)`,
    { replacements: { fundingTxId, memberId, walletId, pspRef: randomUUID() } },
  );
  await sequelize.query(
    `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after, funding_tx_id)
     VALUES (:walletId, 'Deposit', 10, 10, :fundingTxId)`,
    { replacements: { walletId, fundingTxId } },
  );
  return { walletId, fundingTxId };
}

describe('database guards on money tables', () => {
  it('rejects UPDATE and DELETE on the append-only ledger', async () => {
    const { walletId } = await seedDepositEntry();
    await expect(
      sequelize.query('UPDATE wallet_txs SET amount = 1000 WHERE wallet_id = :walletId', { replacements: { walletId } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      sequelize.query('DELETE FROM wallet_txs WHERE wallet_id = :walletId', { replacements: { walletId } }),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a second ledger entry of the same type for one funding transaction', async () => {
    const { walletId, fundingTxId } = await seedDepositEntry();
    await expect(
      sequelize.query(
        `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after, funding_tx_id)
         VALUES (:walletId, 'Deposit', 10, 20, :fundingTxId)`,
        { replacements: { walletId, fundingTxId } },
      ),
    ).rejects.toMatchObject({ parent: { constraint: 'wallet_txs_funding_tx_type_unique' } });
  });

  it('rejects a negative wallet balance', async () => {
    const { walletId } = await createWallet();
    await expect(
      sequelize.query('UPDATE wallets SET balance = -1 WHERE id = :walletId', { replacements: { walletId } }),
    ).rejects.toThrow(/wallets_balance_non_negative/);
  });

  it('rejects a ledger entry whose sign contradicts its type', async () => {
    const { walletId } = await createWallet();
    await expect(
      sequelize.query(
        `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after) VALUES (:walletId, 'Wager', 5, 5)`,
        { replacements: { walletId } },
      ),
    ).rejects.toThrow(/wallet_txs_amount_sign/);
  });

  it('rejects a funding transaction status outside the state machine', async () => {
    const { fundingTxId } = await seedDepositEntry();
    await expect(
      sequelize.query(`UPDATE funding_txs SET status = 'Refunded' WHERE id = :fundingTxId`, {
        replacements: { fundingTxId },
      }),
    ).rejects.toThrow(/funding_txs_status_valid/);
  });
});
