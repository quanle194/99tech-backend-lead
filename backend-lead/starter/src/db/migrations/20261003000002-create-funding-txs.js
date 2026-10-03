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
           )`,
        { transaction },
      );
      await queryInterface.addIndex('funding_txs', ['wallet_id'], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_txs');
  },
};
