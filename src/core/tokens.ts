import { base32, randomBytes, sha256Hex } from "./encoding.ts";

/** Lane address token: 160 random bits as lower-case base32 (32 characters). */
export function generateAddressToken(): string {
  return base32(randomBytes(20));
}

/** Agent bearer token: recognisable prefix plus 256 random bits. */
export function generateAgentToken(): string {
  return `aia_${base32(randomBytes(32))}`;
}

/** Share-link token: 192 random bits. */
export function generateShareToken(): string {
  return base32(randomBytes(24));
}

export const AGENT_TOKEN_PATTERN = /^aia_[a-z2-7]{52}$/;
export const SHARE_TOKEN_PATTERN = /^[a-z2-7]{39}$/;

export { sha256Hex };
