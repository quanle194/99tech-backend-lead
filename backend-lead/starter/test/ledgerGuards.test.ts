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
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `INSERT INTO funding_txs (id, member_id, wallet_id, type, status, amount, turnover_multiplier, psp_ref)
       VALUES (:fundingTxId, :memberId, :walletId, 'Deposit', 'Completed', 10, 0, :pspRef)`,
      { replacements: { fundingTxId, memberId, walletId, pspRef: randomUUID() }, transaction },
    );
    await sequelize.query(
      `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after, funding_tx_id)
       VALUES (:walletId, 'Deposit', 10, 10, :fundingTxId)`,
      { replacements: { walletId, fundingTxId }, transaction },
    );
    await sequelize.query('UPDATE wallets SET balance = 10 WHERE id = :walletId', {
      replacements: { walletId },
      transaction,
    });
  });
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
        `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after, turnover_accrued_after)
         VALUES (:walletId, 'Wager', 5, 5, -5)`,
        { replacements: { walletId } },
      ),
    ).rejects.toThrow(/wallet_txs_amount_sign/);
  });

  it('rejects a funding transaction status outside the state machine', async () => {
    const { memberId, walletId } = await createWallet();
    const fundingTxId = randomUUID();
    await sequelize.query(
      `INSERT INTO funding_txs (id, member_id, wallet_id, type, amount, turnover_multiplier, psp_ref)
       VALUES (:fundingTxId, :memberId, :walletId, 'Deposit', 1, 0, :pspRef)`,
      { replacements: { fundingTxId, memberId, walletId, pspRef: randomUUID() } },
    );
    await expect(
      sequelize.query(`UPDATE funding_txs SET status = 'Refunded' WHERE id = :fundingTxId`, {
        replacements: { fundingTxId },
      }),
    ).rejects.toThrow(/funding_txs_status_valid/);
  });
});

describe('database guards on funding transactions', () => {
  it('rejects moving a terminal funding transaction to another status', async () => {
    const { fundingTxId } = await seedDepositEntry();
    await expect(
      sequelize.query(`UPDATE funding_txs SET status = 'Pending' WHERE id = :fundingTxId`, {
        replacements: { fundingTxId },
      }),
    ).rejects.toThrow(/is Completed and cannot become Pending/);
  });

  it('rejects changing the amount of a funding transaction after insert', async () => {
    const { fundingTxId } = await seedDepositEntry();
    await expect(
      sequelize.query('UPDATE funding_txs SET amount = 999999 WHERE id = :fundingTxId', { replacements: { fundingTxId } }),
    ).rejects.toThrow(/terms are immutable/);
  });

  it('rejects a funding transaction whose wallet belongs to another member', async () => {
    const owner = await createWallet();
    const other = await createWallet();
    await expect(
      sequelize.query(
        `INSERT INTO funding_txs (member_id, wallet_id, type, amount) VALUES (:memberId, :walletId, 'Withdrawal', 1)`,
        { replacements: { memberId: other.memberId, walletId: owner.walletId } },
      ),
    ).rejects.toMatchObject({ parent: { constraint: 'funding_txs_wallet_member_fkey' } });
  });
});

describe('database guards that keep the balance equal to the ledger', () => {
  it('rejects a balance change that has no ledger entry', async () => {
    const { walletId } = await seedDepositEntry();
    await expect(
      sequelize.query('UPDATE wallets SET balance = balance + 500 WHERE id = :walletId', { replacements: { walletId } }),
    ).rejects.toThrow(/balance does not match its ledger/);
  });

  it('rejects a ledger entry that does not move the balance', async () => {
    const { walletId } = await createWallet();
    await expect(
      sequelize.query(
        `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after) VALUES (:walletId, 'Wager', -1, 0)`,
        { replacements: { walletId } },
      ),
    ).rejects.toThrow(/ledger chain broken/);
  });

  it('rejects a ledger entry whose balance_after does not extend the previous entry', async () => {
    const { walletId, fundingTxId } = await seedDepositEntry();
    await expect(
      sequelize.transaction(async (transaction) => {
        await sequelize.query(
          `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after, funding_tx_id)
           VALUES (:walletId, 'Withdrawal', -5, 4, :fundingTxId)`,
          { replacements: { walletId, fundingTxId }, transaction },
        );
      }),
    ).rejects.toThrow(/ledger chain broken/);
  });
});

describe('database guard tying ledger entries to their funding transaction', () => {
  async function pendingDeposit() {
    const { memberId, walletId } = await createWallet();
    const fundingTxId = randomUUID();
    await sequelize.query(
      `INSERT INTO funding_txs (id, member_id, wallet_id, type, amount, turnover_multiplier, psp_ref)
       VALUES (:fundingTxId, :memberId, :walletId, 'Deposit', 10, 0, :pspRef)`,
      { replacements: { fundingTxId, memberId, walletId, pspRef: randomUUID() } },
    );
    return { walletId, fundingTxId };
  }

  async function credit(walletId: string, fundingTxId: string, amount: string, complete = false) {
    await sequelize.transaction(async (transaction) => {
      if (complete) {
        await sequelize.query(`UPDATE funding_txs SET status = 'Completed' WHERE id = :fundingTxId`, {
          replacements: { fundingTxId },
          transaction,
        });
      }
      await sequelize.query(
        `INSERT INTO wallet_txs (wallet_id, type, amount, balance_after, funding_tx_id)
         VALUES (:walletId, 'Deposit', :amount, :amount, :fundingTxId)`,
        { replacements: { walletId, fundingTxId, amount }, transaction },
      );
      await sequelize.query('UPDATE wallets SET balance = :amount WHERE id = :walletId', {
        replacements: { walletId, amount },
        transaction,
      });
    });
  }

  it('rejects crediting a deposit that is not Completed', async () => {
    const { walletId, fundingTxId } = await pendingDeposit();
    await expect(credit(walletId, fundingTxId, '10')).rejects.toThrow(/does not match funding transaction/);
  });

  it('rejects crediting a different amount than the deposit', async () => {
    const { walletId, fundingTxId } = await pendingDeposit();
    await expect(credit(walletId, fundingTxId, '1000', true)).rejects.toThrow(/does not match funding transaction/);
  });

  it('rejects completing a deposit without crediting it', async () => {
    const { fundingTxId } = await pendingDeposit();
    await expect(
      sequelize.query(`UPDATE funding_txs SET status = 'Completed' WHERE id = :fundingTxId`, {
        replacements: { fundingTxId },
      }),
    ).rejects.toThrow(/needs exactly one ledger entry/);
  });

  it('rejects a withdrawal without its debit', async () => {
    const { memberId, walletId } = await createWallet();
    await expect(
      sequelize.query(
        `INSERT INTO funding_txs (member_id, wallet_id, type, amount) VALUES (:memberId, :walletId, 'Withdrawal', 1)`,
        { replacements: { memberId, walletId } },
      ),
    ).rejects.toThrow(/needs exactly one ledger entry/);
  });
});

describe('database guard keeping turnover equal to the ledger', () => {
  it('rejects raising accrued turnover without a wager in the ledger', async () => {
    const { walletId } = await seedDepositEntry();
    await expect(
      sequelize.query('UPDATE wallets SET turnover_accrued = turnover_accrued + 1000 WHERE id = :walletId', {
        replacements: { walletId },
      }),
    ).rejects.toThrow(/turnover does not match its ledger/);
  });
});
