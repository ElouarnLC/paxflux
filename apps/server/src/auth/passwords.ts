import { hash, verify, Algorithm } from '@node-rs/argon2';

// OWASP Recommended parameters for Argon2id
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,       // 3 iterations
  parallelism: 1,    // 1 lane
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, plainText: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plainText, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
