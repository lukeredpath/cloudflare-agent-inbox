import { randomBytes } from "./encoding.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit millisecond timestamp then 80 random bits, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let random = "";
  for (const byte of randomBytes(16)) random += CROCKFORD[byte % 32];
  return time + random;
}
