import { Sequelize } from 'sequelize';
import { config } from '../config';

export const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: false,
  define: { underscored: true },
  pool: { max: 5 },
  // A stuck transaction must not hold a wallet lock indefinitely: waiters give up after
  // lock_timeout and get a retryable 503, and an abandoned transaction is closed by Postgres.
  dialectOptions: { lock_timeout: 2000, idle_in_transaction_session_timeout: 10000 },
});
