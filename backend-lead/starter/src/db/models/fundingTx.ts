import { DataTypes, Model, Sequelize } from 'sequelize';

export type FundingTxType = 'Deposit' | 'Withdrawal';
export type FundingTxStatus = 'Pending' | 'Completed' | 'Failed';

// One row per deposit or withdrawal. `status` only changes through fundingTxStateMachine.
export class FundingTx extends Model {
  declare id: string;
  declare memberId: string;
  declare walletId: string;
  declare type: FundingTxType;
  declare status: FundingTxStatus;
  declare amount: string;
  declare turnoverMultiplier: number | null;
  declare pspRef: string | null;
  declare settledAt: Date | null;
}

export function initFundingTx(sequelize: Sequelize): void {
  FundingTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      walletId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING(16), allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'Pending' },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: true },
      pspRef: { type: DataTypes.STRING(128), allowNull: true, unique: true },
      settledAt: { type: DataTypes.DATE, allowNull: true },
    },
    { sequelize, tableName: 'funding_txs', underscored: true },
  );
}
