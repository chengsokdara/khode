// Password hashing (M8): PBKDF2-SHA-256 via WebCrypto. Inline cases rather
// than golden fixtures — hashing embeds a random salt, so the contract is
// roundtrip/behavior, not byte-exact output.
import { describe, expect, it } from 'vitest';
import { PASSWORD_HASH_PREFIX, PBKDF2_ITERATIONS, hashPassword, verifyPassword } from '../../src/worker/crypto';

describe('password hashing', () => {
  it('hashes with the versioned pbkdf2 format and default cost', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const parts = hash.split(':');
    expect(parts[0]).toBe(PASSWORD_HASH_PREFIX);
    expect(Number(parts[1])).toBe(PBKDF2_ITERATIONS);
    expect(parts[2]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // salt b64
    expect(parts[3]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // hash b64
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('hunter2hunter2');
    expect(await verifyPassword('hunter2hunter2', hash)).toBe(true);
    expect(await verifyPassword('hunter2hunter3', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a unique salt per hash', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('honors the iteration count recorded in the stored hash', async () => {
    const hash = await hashPassword('legacy-cost', 1000);
    expect(Number(hash.split(':')[1])).toBe(1000);
    expect(await verifyPassword('legacy-cost', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('rejects malformed / foreign-format stored hashes without throwing', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('x', `${PASSWORD_HASH_PREFIX}:notanumber:aaa:bbb`)).toBe(false);
    expect(await verifyPassword('x', `${PASSWORD_HASH_PREFIX}:1000:notb64!!:bbb`)).toBe(false);
    expect(await verifyPassword('x', `${PASSWORD_HASH_PREFIX}:99999999:aaaa:bbbb`)).toBe(false); // absurd cost
  });
});
