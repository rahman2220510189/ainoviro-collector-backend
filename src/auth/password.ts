import { compare, hash } from 'bcryptjs';

/** bcrypt work factor for real passwords. Higher = slower to brute-force. */
export const BCRYPT_COST = 12;

export function hashPassword(plain: string, cost: number = BCRYPT_COST): Promise<string> {
  return hash(plain, cost);
}

export function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  return compare(plain, passwordHash);
}

// Created lazily on first use, then reused.
let dummyHash: Promise<string> | undefined;

/**
 * Runs a bcrypt comparison that always fails. Used when the email does not
 * exist, so "unknown email" takes about as long as "wrong password" and an
 * attacker cannot discover valid emails by timing the response.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hashPassword('timing-equalizer-not-a-real-password');
  await verifyPassword(plain, await dummyHash);
  return false;
}