import express, { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from './lib/errors';
import { healthRouter } from './routes/health';
import { membersRouter } from './routes/members';
import { depositsRouter } from './routes/deposits';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', details: err.issues });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, ...err.details });
    return;
  }
  // express.json() parse failures carry type 'entity.parse.failed'.
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
};

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/members', membersRouter);
  app.use('/deposits', depositsRouter);
  // Mount your new routes here.

  app.use(errorHandler);
  return app;
}
