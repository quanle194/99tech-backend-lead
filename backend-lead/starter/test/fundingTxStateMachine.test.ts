import { canTransition } from '../src/services/fundingTxStateMachine';

describe('funding transaction state machine', () => {
  it.each([
    ['Pending', 'Completed', true],
    ['Pending', 'Failed', true],
    ['Pending', 'Pending', false],
    ['Completed', 'Failed', false],
    ['Completed', 'Pending', false],
    ['Completed', 'Completed', false],
    ['Failed', 'Completed', false],
    ['Failed', 'Pending', false],
    ['Failed', 'Failed', false],
  ] as const)('%s -> %s allowed: %p', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
});
