'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Audit trail of every callback for a known pspRef, including the rejected ones.
      await queryInterface.createTable(
        'psp_callback_events',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          funding_tx_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'funding_txs', key: 'id' } },
          status: { type: Sequelize.STRING(16), allowNull: false },
          amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
          outcome: { type: Sequelize.STRING(32), allowNull: false },
          received_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE psp_callback_events
           ADD CONSTRAINT psp_callback_events_status_valid CHECK (status IN ('completed', 'failed')),
           ADD CONSTRAINT psp_callback_events_outcome_valid
             CHECK (outcome IN ('Applied', 'Duplicate', 'AmountMismatch', 'InvalidTransition'))`,
        { transaction },
      );
      await queryInterface.addIndex('psp_callback_events', ['funding_tx_id'], { transaction });
      await queryInterface.sequelize.query(
        `CREATE TRIGGER psp_callback_events_append_only BEFORE UPDATE OR DELETE ON psp_callback_events
         FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation()`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('psp_callback_events', { transaction });
    });
  },
};
