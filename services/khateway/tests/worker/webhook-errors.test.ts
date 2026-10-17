// Webhook error discrimination (M15 hardening): the LS webhook may only answer
// {ok, duplicate} for genuine UNIQUE-constraint violations — any other D1
// failure must propagate so Lemon Squeezy retries. Drizzle wraps driver
// errors, so the helper walks the cause chain. Inline cases — the contract is
// error-shape behavior, not wire output.
import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../../src/worker/routes/webhooks';

// Mimics drizzle's DrizzleQueryError: generic message, real D1 error as cause.
function drizzleWrapped(d1Message: string): Error {
  const d1 = new Error(d1Message);
  const wrapped = new Error(`Failed query: insert into "balance_entries" ...`);
  (wrapped as Error & { cause?: unknown }).cause = d1;
  return wrapped;
}

describe('isUniqueViolation', () => {
  it('matches the constraint signature through a drizzle-wrapped cause chain', () => {
    expect(isUniqueViolation(drizzleWrapped('UNIQUE constraint failed: balance_entries.ref'), 'balance_entries')).toBe(true);
    expect(
      isUniqueViolation(
        drizzleWrapped('UNIQUE constraint failed: webhook_events.source, webhook_events.event_key'),
        'webhook_events',
      ),
    ).toBe(true);
  });

  it('matches a bare (unwrapped) constraint error', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: balance_entries.ref'), 'balance_entries')).toBe(true);
  });

  it('rejects other tables, other errors, and deeper mismatches', () => {
    expect(isUniqueViolation(drizzleWrapped('UNIQUE constraint failed: balance_entries.ref'), 'webhook_events')).toBe(
      false,
    );
    expect(isUniqueViolation(new Error('D1_ERROR: too many requests'), 'balance_entries')).toBe(false);
    expect(isUniqueViolation(drizzleWrapped('FAILED SQL constraint check'), 'balance_entries')).toBe(false);
    expect(isUniqueViolation(null, 'balance_entries')).toBe(false);
    expect(isUniqueViolation(undefined, 'balance_entries')).toBe(false);
    expect(isUniqueViolation('UNIQUE constraint failed: balance_entries.ref', 'balance_entries')).toBe(false);
  });

  it('does not match when the table name is only a substring of another', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: balance_entries_ref_old.ref'), 'balance_entries')).toBe(
      false,
    );
  });
});
