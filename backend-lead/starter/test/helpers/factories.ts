import { randomUUID } from 'crypto';
import * as memberService from '../../src/services/memberService';

export async function createWallet(): Promise<{ memberId: string; walletId: string }> {
  const { member, wallet } = await memberService.createMember(`m-${randomUUID().slice(0, 12)}`);
  return { memberId: member.id, walletId: wallet.id };
}
