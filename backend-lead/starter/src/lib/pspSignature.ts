import { createHmac, timingSafeEqual } from 'crypto';
import { Request, RequestHandler } from 'express';
import { AppError } from './errors';

export type RawBodyRequest = Request & { rawBody?: Buffer };

// Callbacks must carry `X-Psp-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Without it anyone
// holding a pspRef (which POST /deposits returns to the player) could complete their own deposit.
// Fail closed: with no secret, callbacks are refused unless unsigned ones are explicitly allowed,
// which .env.example does for the brief's unsigned mock PSP.
export function verifyPspSignature(secret: string | undefined, allowUnsigned: boolean): RequestHandler {
  return (req, _res, next) => {
    if (!secret) {
      next(allowUnsigned ? undefined : new AppError(401, 'invalid_signature'));
      return;
    }
    const body = (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
    const received = Buffer.from(req.get('X-Psp-Signature') ?? '');
    const valid = received.length === expected.length && timingSafeEqual(received, expected);
    next(valid ? undefined : new AppError(401, 'invalid_signature'));
  };
}
