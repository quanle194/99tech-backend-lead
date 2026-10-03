import { sequelize } from '../sequelize';
import { Member, initMember } from './member';
import { Wallet, initWallet } from './wallet';
import { FundingTx, initFundingTx } from './fundingTx';
import { WalletTx, initWalletTx } from './walletTx';
import { PspCallbackEvent, initPspCallbackEvent } from './pspCallbackEvent';

initMember(sequelize);
initWallet(sequelize);
initFundingTx(sequelize);
initWalletTx(sequelize);
initPspCallbackEvent(sequelize);

Member.hasOne(Wallet, { foreignKey: 'memberId', as: 'wallet' });
Wallet.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

export { Member, Wallet, FundingTx, WalletTx, PspCallbackEvent };
