// Shared crypto for Khateway: AES-256-GCM secret encryption + HMAC session tokens.
import type { Env } from './env';

const te = new TextEncoder();
const td = new TextDecoder();

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return b64ToBytes(s);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time hex comparison. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time string compare for short secrets (same-length UTF-8). */
export function safeEqualStr(a: string, b: string): boolean {
  const ab = te.encode(a);
  const bb = te.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function aesGcmKey(env: Env): Promise<CryptoKey> {
  let raw = new Uint8Array(0);
  try {
    raw = b64ToBytes(env.ENCRYPTION_KEY);
  } catch {
    // fallthrough to length check
  }
  if (raw.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Returns "v1.<iv-b64>.<ciphertext-b64>" or null when plain is empty. */
export async function encryptSecret(env: Env, plain: string): Promise<string | null> {
  if (!plain) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesGcmKey(env),
    te.encode(plain),
  );
  return `v1.${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ct))}`;
}

export async function decryptSecret(
  env: Env,
  stored: string | null | undefined,
): Promise<string | null> {
  if (!stored) return null;
  const parts = stored.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('malformed stored secret');
  const iv = b64ToBytes(parts[1]);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    await aesGcmKey(env),
    b64ToBytes(parts[2]),
  );
  return td.decode(pt);
}

export async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

export async function hmacVerify(secret: string, payload: string, sigHex: string): Promise<boolean> {
  return safeEqualHex(await hmacSign(secret, payload), sigHex.toLowerCase());
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

// --- password hashing (M8 portal accounts) ----------------------------------
//
// Workers have no bcrypt/argon2; PBKDF2-SHA-256 via WebCrypto is the platform
// norm. The stored format is versioned so the iteration count can be raised
// later without breaking existing users:
//   pbkdf2-sha256:<iterations>:<salt-b64>:<hash-b64>
// verifyPassword honors the iterations recorded in the stored string.

export const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256';
/** Default cost for NEW hashes (verify reads the count from the stored hash). */
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2Bits(plain: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', te.encode(plain), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(plain: string, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(plain, salt, iterations);
  return `${PASSWORD_HASH_PREFIX}:${iterations}:${bytesToB64(salt)}:${bytesToB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  let salt: Uint8Array<ArrayBuffer>;
  try {
    salt = b64ToBytes(parts[2]);
  } catch {
    return false;
  }
  const bits = await pbkdf2Bits(plain, salt, iterations);
  // Constant-time compare of b64 digests (equal length by construction).
  return safeEqualStr(bytesToB64(new Uint8Array(bits)), parts[3]);
}
