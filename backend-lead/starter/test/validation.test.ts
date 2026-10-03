import request from 'supertest';
import { createApp } from '../src/app';
import { moneyString } from '../src/lib/validation';

describe('moneyString', () => {
  it.each(['1', '0.5', '100.50', '0.000000000000000001', '1000000000'])('accepts %p', (value) => {
    expect(moneyString.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a JSON number', 100.5],
    ['scientific notation', '1e5'],
    ['a negative amount', '-1'],
    ['an explicit plus sign', '+1'],
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['surrounding whitespace', ' 1'],
    ['a leading dot', '.5'],
    ['a trailing dot', '1.'],
    ['a leading zero', '01'],
    ['19 decimals (Postgres would round them)', '0.0000000000000000001'],
    ['an amount above the cap', '1000000000.000000000000000001'],
    ['an empty string', ''],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(moneyString.safeParse(value).success).toBe(false);
  });
});

describe('request body errors', () => {
  it('maps malformed JSON to 400 instead of 500', async () => {
    const res = await request(createApp())
      .post('/members')
      .set('Content-Type', 'application/json')
      .send('{"username": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json' });
  });
});
