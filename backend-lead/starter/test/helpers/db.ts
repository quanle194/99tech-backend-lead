import { QueryTypes } from 'sequelize';
import { sequelize } from '../../src/db/sequelize';
import '../../src/db/models';

export function useTestDb(): void {
  beforeAll(async () => {
    await sequelize.authenticate();
  });

  beforeEach(async () => {
    await sequelize.truncate({ cascade: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });
}

export function rows<T extends object>(sql: string, replacements: Record<string, unknown> = {}): Promise<T[]> {
  return sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
}

// Reconciles one wallet against its ledger and funding transactions with exact NUMERIC arithmetic in
// Postgres. Every check returns the offending rows, so a failure shows what broke, not just that it broke.
export async function assertWalletInvariants(walletId: string): Promise<void> {
  const checks: Record<string, string> = {
    'I1 balance equals the ledger sum': `
      SELECT w.balance, COALESCE(SUM(t.amount), 0) AS ledger_sum
      FROM wallets w LEFT JOIN wallet_txs t ON t.wallet_id = w.id
      WHERE w.id = :walletId GROUP BY w.id HAVING w.balance <> COALESCE(SUM(t.amount), 0)`,
    'I2 balance is never negative': `
      SELECT balance FROM wallets WHERE id = :walletId AND balance < 0`,
    'I3 completed deposit has exactly one matching credit, others none': `
      SELECT f.id, f.status, COUNT(t.id) AS entries, SUM(t.amount) AS credited
      FROM funding_txs f LEFT JOIN wallet_txs t ON t.funding_tx_id = f.id
      WHERE f.wallet_id = :walletId AND f.type = 'Deposit' GROUP BY f.id
      HAVING (f.status = 'Completed' AND (COUNT(t.id) <> 1 OR SUM(t.amount) <> f.amount))
          OR (f.status <> 'Completed' AND COUNT(t.id) <> 0)`,
    'I4 withdrawal has exactly one matching debit': `
      SELECT f.id, COUNT(t.id) AS entries, SUM(t.amount) AS debited
      FROM funding_txs f LEFT JOIN wallet_txs t ON t.funding_tx_id = f.id
      WHERE f.wallet_id = :walletId AND f.type = 'Withdrawal' GROUP BY f.id
      HAVING COUNT(t.id) <> 1 OR SUM(t.amount) <> -f.amount`,
    'I6 turnover counters match their sources': `
      SELECT w.turnover_required, w.turnover_accrued FROM wallets w
      WHERE w.id = :walletId AND (
        w.turnover_required <> (SELECT COALESCE(SUM(amount * turnover_multiplier), 0) FROM funding_txs
                                WHERE wallet_id = w.id AND type = 'Deposit' AND status = 'Completed')
        OR w.turnover_accrued <> (SELECT COALESCE(-SUM(amount), 0) FROM wallet_txs
                                  WHERE wallet_id = w.id AND type = 'Wager'))`,
    'I8 balance_after chains entry by entry': `
      SELECT id, balance_after, running FROM (
        SELECT id, balance_after, SUM(amount) OVER (ORDER BY id) AS running
        FROM wallet_txs WHERE wallet_id = :walletId) s
      WHERE balance_after <> running`,
  };

  const violations: Record<string, unknown[]> = {};
  for (const [name, sql] of Object.entries(checks)) {
    const found = await rows(sql, { walletId });
    if (found.length > 0) violations[name] = found;
  }
  expect(violations).toEqual({});
}
