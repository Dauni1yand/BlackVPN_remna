import { randomBytes } from 'node:crypto';

// Generates a password satisfying Remnawave's superadmin policy (24+
// chars, at least one upper/lower/digit) with comfortable margin, using
// only [A-Za-z0-9] so it's always safe to pass around as a plain shell
// argument or env var without quoting surprises.
export function generateStrongPassword(length = 32): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;

  const pick = (charset: string): string => charset[randomBytes(1)[0] % charset.length];

  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < length) {
    chars.push(pick(all));
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}
