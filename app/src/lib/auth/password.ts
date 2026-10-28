import bcrypt from "bcryptjs";

/** bcrypt cost factor. 10 is the bcryptjs default and keeps sign-in fast. */
const COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
