import { DataTypes, Model, Sequelize } from 'sequelize';

export type WalletTxType = 'Deposit' | 'Wager' | 'Withdrawal';

// Append-only ledger (a DB trigger rejects UPDATE and DELETE). Only walletService.applyEntry writes it.
export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare type: WalletTxType;
  declare amount: string;
  declare balanceAfter: string;
  declare turnoverRequiredAfter: string;
  declare turnoverAccruedAfter: string;
  declare fundingTxId: string | null;
  declare idempotencyKey: string | null;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING(16), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverRequiredAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      turnoverAccruedAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      fundingTxId: { type: DataTypes.UUID, allowNull: true },
      idempotencyKey: { type: DataTypes.STRING(64), allowNull: true },
    },
    { sequelize, tableName: 'wallet_txs', underscored: true, updatedAt: false },
  );
}
