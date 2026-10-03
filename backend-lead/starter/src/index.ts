import { createApp } from './app';
import { config } from './config';
import { sequelize } from './db/sequelize';

async function main() {
  // The unsigned mock contract is for local use only: never accept unsigned callbacks in production.
  if (config.env === 'production' && !config.pspWebhookSecret) {
    throw new Error('PSP_WEBHOOK_SECRET is required in production');
  }
  await sequelize.authenticate();
  const app = createApp();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`mini-wallet-service listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
