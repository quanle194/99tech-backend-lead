'use strict';

// The ledger and the database guards that keep it honest even if a future code path skips the service:
//   I1  balance = SUM(amount)        chain check per entry + commit-time check against the wallet
//   I3  deposit credited once        UNIQUE (funding_tx_id, type), entry must match its funding tx,
//   I4  withdrawal debited once      and a settled funding tx must have exactly one entry at commit
//   I6  turnover counters            recorded per entry and checked like balance
//   I7  append-only                  UPDATE and DELETE rejected
//   I8  balance_after chains         checked per entry under the wallet lock
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await queryInterface.createTable(
        'wallet_txs',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          wallet_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'wallets', key: 'id' } },
          type: { type: Sequelize.STRING(16), allowNull: false },
          // Signed: credits > 0, debits < 0, so SUM(amount) is the balance.
          amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
          balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
          turnover_required_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
          turnover_accrued_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
          funding_tx_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'funding_txs', key: 'id' } },
          idempotency_key: { type: Sequelize.STRING(64), allowNull: true },
          created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        },
        { transaction },
      );
      await q(
        `ALTER TABLE wallet_txs
           ADD CONSTRAINT wallet_txs_type_valid CHECK (type IN ('Deposit', 'Wager', 'Withdrawal')),
           ADD CONSTRAINT wallet_txs_amount_sign CHECK (
             (type = 'Deposit' AND amount > 0) OR (type IN ('Wager', 'Withdrawal') AND amount < 0)
           ),
           ADD CONSTRAINT wallet_txs_funding_link CHECK ((type = 'Wager') = (funding_tx_id IS NULL)),
           ADD CONSTRAINT wallet_txs_balance_after_non_negative CHECK (balance_after >= 0)`,
      );
      await queryInterface.addIndex('wallet_txs', ['funding_tx_id', 'type'], {
        unique: true,
        name: 'wallet_txs_funding_tx_type_unique',
        where: { funding_tx_id: { [Sequelize.Op.ne]: null } },
        transaction,
      });
      // A client retry with the same key can never produce a second debit on the same wallet.
      await queryInterface.addIndex('wallet_txs', ['wallet_id', 'idempotency_key'], {
        unique: true,
        name: 'wallet_txs_wallet_idempotency_key_unique',
        where: { idempotency_key: { [Sequelize.Op.ne]: null } },
        transaction,
      });
      await queryInterface.addIndex('wallet_txs', ['wallet_id', 'id'], { transaction });

      await q(
        `CREATE FUNCTION reject_append_only_mutation() RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await q(
        `CREATE TRIGGER wallet_txs_append_only BEFORE UPDATE OR DELETE ON wallet_txs
         FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation()`,
      );

      // Each entry must extend the previous one for balance and both turnover counters. The trigger takes
      // the wallet lock itself; ids are assigned before it, so a writer that skips the lock can interleave
      // ids, and the commit-time check below then rejects the transaction.
      await q(
        `CREATE FUNCTION check_ledger_chain() RETURNS trigger AS $$
         DECLARE
           prev_balance NUMERIC(36, 18);
           prev_required NUMERIC(36, 18);
           prev_accrued NUMERIC(36, 18);
           required_delta NUMERIC(36, 18) := 0;
           accrued_delta NUMERIC(36, 18) := 0;
         BEGIN
           PERFORM 1 FROM wallets WHERE id = NEW.wallet_id FOR NO KEY UPDATE;
           SELECT balance_after, turnover_required_after, turnover_accrued_after
             INTO prev_balance, prev_required, prev_accrued
             FROM wallet_txs WHERE wallet_id = NEW.wallet_id ORDER BY id DESC LIMIT 1;
           IF NEW.type = 'Deposit' THEN
             SELECT NEW.amount * turnover_multiplier INTO required_delta FROM funding_txs WHERE id = NEW.funding_tx_id;
           ELSIF NEW.type = 'Wager' THEN
             accrued_delta := -NEW.amount;
           END IF;
           IF COALESCE(prev_balance, 0) + NEW.amount <> NEW.balance_after
              OR COALESCE(prev_required, 0) + required_delta <> NEW.turnover_required_after
              OR COALESCE(prev_accrued, 0) + accrued_delta <> NEW.turnover_accrued_after THEN
             RAISE EXCEPTION 'ledger chain broken for wallet %', NEW.wallet_id;
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await q(
        `CREATE TRIGGER wallet_txs_chain BEFORE INSERT ON wallet_txs
         FOR EACH ROW EXECUTE FUNCTION check_ledger_chain()`,
      );

      // An entry linked to a funding transaction must belong to the same wallet, have the matching type and
      // exactly its amount, and a deposit must already be Completed.
      await q(
        `CREATE FUNCTION check_ledger_funding_tx() RETURNS trigger AS $$
         DECLARE
           f_wallet UUID;
           f_type VARCHAR;
           f_status VARCHAR;
           f_amount NUMERIC(36, 18);
         BEGIN
           IF NEW.funding_tx_id IS NULL THEN
             RETURN NEW;
           END IF;
           SELECT wallet_id, type, status, amount INTO f_wallet, f_type, f_status, f_amount
             FROM funding_txs WHERE id = NEW.funding_tx_id;
           IF f_wallet <> NEW.wallet_id
              OR f_type <> NEW.type
              OR NEW.amount <> (CASE WHEN f_type = 'Deposit' THEN f_amount ELSE -f_amount END)
              OR (f_type = 'Deposit' AND f_status <> 'Completed') THEN
             RAISE EXCEPTION 'ledger entry does not match funding transaction %', NEW.funding_tx_id;
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await q(
        `CREATE TRIGGER wallet_txs_funding_tx_match BEFORE INSERT ON wallet_txs
         FOR EACH ROW EXECUTE FUNCTION check_ledger_funding_tx()`,
      );

      // At COMMIT a wallet's balance and turnover must equal its latest entry. With the chain check this
      // makes balance = SUM(ledger) without summing the ledger.
      await q(
        `CREATE FUNCTION check_wallet_matches_ledger() RETURNS trigger AS $$
         DECLARE
           target UUID;
           w_balance NUMERIC(36, 18);
           w_required NUMERIC(36, 18);
           w_accrued NUMERIC(36, 18);
           l_balance NUMERIC(36, 18);
           l_required NUMERIC(36, 18);
           l_accrued NUMERIC(36, 18);
         BEGIN
           IF TG_TABLE_NAME = 'wallets' THEN
             target := NEW.id;
           ELSE
             target := NEW.wallet_id;
           END IF;
           SELECT balance, turnover_required, turnover_accrued INTO w_balance, w_required, w_accrued
             FROM wallets WHERE id = target;
           SELECT balance_after, turnover_required_after, turnover_accrued_after
             INTO l_balance, l_required, l_accrued
             FROM wallet_txs WHERE wallet_id = target ORDER BY id DESC LIMIT 1;
           IF w_balance <> COALESCE(l_balance, 0) THEN
             RAISE EXCEPTION 'wallet % balance does not match its ledger', target;
           END IF;
           IF w_required <> COALESCE(l_required, 0) OR w_accrued <> COALESCE(l_accrued, 0) THEN
             RAISE EXCEPTION 'wallet % turnover does not match its ledger', target;
           END IF;
           RETURN NULL;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await q(
        `CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger
         AFTER INSERT OR UPDATE OF balance, turnover_required, turnover_accrued ON wallets
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION check_wallet_matches_ledger()`,
      );
      await q(
        `CREATE CONSTRAINT TRIGGER wallet_txs_balance_matches_wallet
         AFTER INSERT ON wallet_txs
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION check_wallet_matches_ledger()`,
      );

      // "Exactly one", not just "at most one": at COMMIT a Completed deposit or any withdrawal must have its entry.
      await q(
        `CREATE FUNCTION check_funding_tx_has_entry() RETURNS trigger AS $$
         DECLARE entries INTEGER;
         BEGIN
           SELECT count(*) INTO entries FROM wallet_txs WHERE funding_tx_id = NEW.id AND type = NEW.type;
           IF (NEW.type = 'Withdrawal' OR NEW.status = 'Completed') AND entries <> 1 THEN
             RAISE EXCEPTION 'funding transaction % needs exactly one ledger entry', NEW.id;
           END IF;
           RETURN NULL;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await q(
        `CREATE CONSTRAINT TRIGGER funding_txs_has_ledger_entry
         AFTER INSERT OR UPDATE OF status ON funding_txs
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION check_funding_tx_has_entry()`,
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `DROP TRIGGER funding_txs_has_ledger_entry ON funding_txs;
         DROP TRIGGER wallets_balance_matches_ledger ON wallets;
         DROP TABLE wallet_txs;
         DROP FUNCTION check_funding_tx_has_entry();
         DROP FUNCTION check_wallet_matches_ledger();
         DROP FUNCTION check_ledger_funding_tx();
         DROP FUNCTION check_ledger_chain();
         DROP FUNCTION reject_append_only_mutation()`,
        { transaction },
      );
    });
  },
};
