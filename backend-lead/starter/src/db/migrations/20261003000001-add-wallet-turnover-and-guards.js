'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Turnover counters live on the wallet so the withdrawal check runs under the same row lock
      // as every balance change. They are a cache: funding_txs + wallet_txs remain the source of truth.
      await queryInterface.addColumn(
        'wallets',
        'turnover_required',
        { type: Sequelize.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
        { transaction },
      );
      await queryInterface.addColumn(
        'wallets',
        'turnover_accrued',
        { type: Sequelize.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE wallets
           ADD CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
           ADD CONSTRAINT wallets_turnover_non_negative CHECK (turnover_required >= 0 AND turnover_accrued >= 0)`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `ALTER TABLE wallets
           DROP CONSTRAINT wallets_turnover_non_negative,
           DROP CONSTRAINT wallets_balance_non_negative`,
        { transaction },
      );
      await queryInterface.removeColumn('wallets', 'turnover_accrued', { transaction });
      await queryInterface.removeColumn('wallets', 'turnover_required', { transaction });
    });
  },
};
