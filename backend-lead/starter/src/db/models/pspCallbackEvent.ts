import { DataTypes, Model, Sequelize } from 'sequelize';

export type CallbackOutcome = 'Applied' | 'Duplicate' | 'AmountMismatch' | 'InvalidTransition';

// Append-only audit of callbacks for known pspRefs, so rejected callbacks leave a trace.
export class PspCallbackEvent extends Model {
  declare id: string;
  declare fundingTxId: string;
  declare status: 'completed' | 'failed';
  declare amount: string;
  declare outcome: CallbackOutcome;
  declare receivedAt: Date;
}

export function initPspCallbackEvent(sequelize: Sequelize): void {
  PspCallbackEvent.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      fundingTxId: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      outcome: { type: DataTypes.STRING(32), allowNull: false },
    },
    {
      sequelize,
      tableName: 'psp_callback_events',
      underscored: true,
      createdAt: 'receivedAt',
      updatedAt: false,
    },
  );
}
