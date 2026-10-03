import { z } from 'zod';
import { dec } from './money';

// Upper bound per request (major units). With turnoverMultiplier <= 100 a single deposit adds at most
// 1e11 of turnover requirement, far from the 1e18 integer range of DECIMAL(36,18).
export const MAX_AMOUNT = '1000000000';

// Money arrives as a plain decimal string. JSON numbers, exponents, signs, whitespace and more than
// 18 decimals are rejected here: Postgres would silently round the 19th decimal.
export const moneyString = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/, 'must be a decimal string with at most 18 decimals')
  .pipe(
    z
      .string()
      .refine((v) => dec(v).gt(0), 'must be greater than 0')
      .refine((v) => dec(v).lte(MAX_AMOUNT), `must be at most ${MAX_AMOUNT}`),
  );

export const uuid = z.string().uuid();
