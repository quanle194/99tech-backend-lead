import express, { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { config } from './config';
import { AppError } from './lib/errors';
import { RawBodyRequest, verifyPspSignature } from './lib/pspSignature';
import { healthRouter } from './routes/health';
import { membersRouter } from './routes/members';
import { depositsRouter } from './routes/deposits';
import { pspCallbacksRouter } from './routes/pspCallbacks';
import { walletsRouter } from './routes/wallets';
import { withdrawalsRouter } from './routes/withdrawals';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', details: err.issues });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, ...err.details });
    return;
  }
  // lock_not_available: lock_timeout expired waiting for a wallet or funding transaction lock.
  if (err?.parent?.code === '55P03') {
    res.status(503).json({ error: 'lock_timeout', retryable: true });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
};

export function createApp(
  options: { pspWebhookSecret?: string; pspAllowUnsigned?: boolean } = {
    pspWebhookSecret: config.pspWebhookSecret,
    pspAllowUnsigned: config.pspAllowUnsigned,
  },
) {
  const app = express();
  // Keep the raw bytes: the callback signature is computed over them, not over re-serialised JSON.
  app.use(express.json({ verify: (req, _res, buf) => ((req as RawBodyRequest).rawBody = buf) }));

  app.use('/health', healthRouter);
  app.use('/members', membersRouter);
  app.use('/deposits', depositsRouter);
  app.use('/psp/callbacks', verifyPspSignature(options.pspWebhookSecret, options.pspAllowUnsigned ?? false), pspCallbacksRouter);
  app.use('/wallets', walletsRouter);
  app.use('/withdrawals', withdrawalsRouter);

  app.use(errorHandler);
  return app;
}
