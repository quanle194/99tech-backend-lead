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
      // The operations queue for money the PSP may hold but we have not credited: a deposit that is not
      // Completed and received a mismatched amount or a `completed` after failing.
      await queryInterface.sequelize.query(
        `CREATE VIEW deposits_needing_reconciliation AS
         SELECT f.id AS funding_tx_id, f.wallet_id, f.psp_ref, f.status, f.amount AS expected_amount,
                e.amount AS reported_amount, e.outcome, e.received_at
         FROM funding_txs f
         JOIN LATERAL (
           SELECT amount, outcome, received_at FROM psp_callback_events
           WHERE funding_tx_id = f.id
             AND (outcome = 'AmountMismatch' OR (outcome = 'InvalidTransition' AND status = 'completed'))
           ORDER BY id DESC LIMIT 1
         ) e ON true
         WHERE f.type = 'Deposit' AND f.status <> 'Completed'`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('DROP VIEW deposits_needing_reconciliation', { transaction });
      await queryInterface.dropTable('psp_callback_events', { transaction });
    });
  },
};
