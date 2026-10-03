'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'wallet_txs',
        {
          // Ids are assigned under the wallet row lock, so within one wallet they follow write order.
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          wallet_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'wallets', key: 'id' } },
          type: { type: Sequelize.STRING(16), allowNull: false },
          // Signed: credits > 0, debits < 0, so SUM(amount) is the balance.
          amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
          balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
          funding_tx_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'funding_txs', key: 'id' } },
          created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE wallet_txs
           ADD CONSTRAINT wallet_txs_type_valid CHECK (type IN ('Deposit', 'Wager', 'Withdrawal')),
           ADD CONSTRAINT wallet_txs_amount_sign CHECK (
             (type = 'Deposit' AND amount > 0) OR (type IN ('Wager', 'Withdrawal') AND amount < 0)
           ),
           ADD CONSTRAINT wallet_txs_funding_link CHECK ((type = 'Wager') = (funding_tx_id IS NULL)),
           ADD CONSTRAINT wallet_txs_balance_after_non_negative CHECK (balance_after >= 0)`,
        { transaction },
      );
      // Last line of defence for exactly-once: a funding transaction can produce one entry per type.
      await queryInterface.addIndex('wallet_txs', ['funding_tx_id', 'type'], {
        unique: true,
        name: 'wallet_txs_funding_tx_type_unique',
        where: { funding_tx_id: { [Sequelize.Op.ne]: null } },
        transaction,
      });
      await queryInterface.addIndex('wallet_txs', ['wallet_id', 'id'], { transaction });
      await queryInterface.sequelize.query(
        `CREATE FUNCTION reject_append_only_mutation() RETURNS trigger AS $$
         BEGIN
           RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
         END;
         $$ LANGUAGE plpgsql`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE TRIGGER wallet_txs_append_only BEFORE UPDATE OR DELETE ON wallet_txs
         FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation()`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('wallet_txs', { transaction });
      await queryInterface.sequelize.query('DROP FUNCTION reject_append_only_mutation()', { transaction });
    });
  },
};
