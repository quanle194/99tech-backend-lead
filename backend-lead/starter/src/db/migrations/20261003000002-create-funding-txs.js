'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'funding_txs',
        {
          id: {
            type: Sequelize.UUID,
            primaryKey: true,
            defaultValue: Sequelize.literal('gen_random_uuid()'),
          },
          member_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'members', key: 'id' } },
          wallet_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'wallets', key: 'id' } },
          type: { type: Sequelize.STRING(16), allowNull: false },
          status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'Pending' },
          amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
          turnover_multiplier: { type: Sequelize.INTEGER, allowNull: true },
          psp_ref: { type: Sequelize.STRING(128), allowNull: true, unique: true },
          settled_at: { type: Sequelize.DATE, allowNull: true },
          created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
          updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE funding_txs
           ADD CONSTRAINT funding_txs_type_valid CHECK (type IN ('Deposit', 'Withdrawal')),
           ADD CONSTRAINT funding_txs_status_valid CHECK (status IN ('Pending', 'Completed', 'Failed')),
           ADD CONSTRAINT funding_txs_amount_positive CHECK (amount > 0),
           ADD CONSTRAINT funding_txs_multiplier_non_negative CHECK (turnover_multiplier >= 0),
           ADD CONSTRAINT funding_txs_type_fields CHECK (
             (type = 'Deposit' AND psp_ref IS NOT NULL AND turnover_multiplier IS NOT NULL)
             OR (type = 'Withdrawal' AND psp_ref IS NULL AND turnover_multiplier IS NULL)
           ),
           ADD CONSTRAINT funding_txs_wallet_member_fkey
             FOREIGN KEY (wallet_id, member_id) REFERENCES wallets (id, member_id)`,
        { transaction },
      );
      await queryInterface.addIndex('funding_txs', ['wallet_id'], { transaction });
      // The state machine in code is the source of truth; these triggers are its backstop. A terminal
      // status never changes, and the terms a callback is checked against cannot be edited after insert.
      await queryInterface.sequelize.query(
        `CREATE FUNCTION reject_terminal_status_change() RETURNS trigger AS $$
         BEGIN
           IF OLD.status <> 'Pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
             RAISE EXCEPTION 'funding transaction % is % and cannot become %', OLD.id, OLD.status, NEW.status;
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE TRIGGER funding_txs_terminal_status BEFORE UPDATE OF status ON funding_txs
         FOR EACH ROW EXECUTE FUNCTION reject_terminal_status_change()`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE FUNCTION reject_funding_tx_terms_change() RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION 'funding transaction % terms are immutable', OLD.id;
         END;
         $$ LANGUAGE plpgsql`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE TRIGGER funding_txs_terms_immutable
         BEFORE UPDATE OF member_id, wallet_id, type, amount, turnover_multiplier, psp_ref ON funding_txs
         FOR EACH ROW
         WHEN ((OLD.member_id, OLD.wallet_id, OLD.type, OLD.amount, OLD.turnover_multiplier, OLD.psp_ref)
               IS DISTINCT FROM (NEW.member_id, NEW.wallet_id, NEW.type, NEW.amount, NEW.turnover_multiplier, NEW.psp_ref))
         EXECUTE FUNCTION reject_funding_tx_terms_change()`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('funding_txs', { transaction });
      await queryInterface.sequelize.query(
        `DROP FUNCTION reject_funding_tx_terms_change();
         DROP FUNCTION reject_terminal_status_change()`,
        { transaction },
      );
    });
  },
};
