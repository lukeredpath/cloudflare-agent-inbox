import type { Db } from "./db.ts";
import { base32, base64url, fromBase64url, fromHex, randomBytes, toHex } from "./encoding.ts";
import { CoreError } from "./lanes.ts";

/**
 * Signing keys for the HTTP ingest endpoint.
 *
 * HMAC needs the secret itself, so it cannot be stored as a hash. Each secret is encrypted to
 * the Worker's ingest key pair (ECDH P-256, HKDF-SHA-256, AES-256-GCM): the public key lives in
 * D1, so the CLI can create keys without ever holding anything that decrypts them; the private
 * key is a Worker secret (INGEST_PRIVATE_KEY), so only the Worker can read a secret back.
 */

/** Public key id: sent in X-Signature-Key-Id. Not secret. */
export const INGEST_KEY_ID_PATTERN = /^aik_[a-z2-7]{16}$/;
/** The signing secret: 256 random bits. Shown once. */
export const INGEST_SECRET_PATTERN = /^ais_[a-z2-7]{52}$/;
/** A lane can have this many active keys, so one can be swapped without downtime. */
export const MAX_ACTIVE_KEYS_PER_LANE = 2;

const PUBLIC_KEY_SETTING = "ingest_public_key";
const BOX_VERSION = "v1";
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

const utf8 = (s: string) => new TextEncoder().encode(s);
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;
// WebCrypto names the peer key `public`; the Workers type definitions spell it `$public`.
const ecdhWith = (peer: CryptoKey) => ({ name: "ECDH", public: peer }) as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];

export interface IngestKeyPair {
  /** JSON JWK, stored as the INGEST_PRIVATE_KEY Worker secret. */
  privateJwk: string;
  /** JSON JWK, stored in D1. */
  publicJwk: string;
}

export async function generateIngestKeyPair(): Promise<IngestKeyPair> {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateJwk: JSON.stringify(privateJwk), publicJwk: JSON.stringify(publicJwk) };
}

/** AES key for one box, bound to the key id and lane so a box cannot be moved to another row. */
async function boxKey(shared: ArrayBuffer, keyId: string, laneId: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(`agent-inbox ingest ${BOX_VERSION} ${keyId} ${laneId}`) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealSecret(publicJwk: string, keyId: string, laneId: string, secret: string): Promise<string> {
  const recipient = await crypto.subtle.importKey("jwk", JSON.parse(publicJwk) as JsonWebKey, ECDH, false, []);
  const ephemeral = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits(ecdhWith(recipient), ephemeral.privateKey, 256);
  const key = await boxKey(shared, keyId, laneId);
  const iv = buf(randomBytes(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(keyId) }, key, utf8(secret));
  const ephemeralRaw = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  return [BOX_VERSION, base64url(ephemeralRaw), base64url(iv), base64url(new Uint8Array(sealed))].join(".");
}

/** Returns the secret, or null if the box cannot be opened with this private key. */
export async function openSecret(privateKey: CryptoKey, box: string, keyId: string, laneId: string): Promise<string | null> {
  const [version, eph, ivText, sealedText, ...rest] = box.split(".");
  if (version !== BOX_VERSION || rest.length || !eph || !ivText || !sealedText) return null;
  const ephemeralRaw = fromBase64url(eph);
  const iv = fromBase64url(ivText);
  const sealed = fromBase64url(sealedText);
  if (!ephemeralRaw || !iv || !sealed) return null;
  try {
    const ephemeral = await crypto.subtle.importKey("raw", ephemeralRaw, ECDH, false, []);
    const shared = await crypto.subtle.deriveBits(ecdhWith(ephemeral), privateKey, 256);
    const key = await boxKey(shared, keyId, laneId);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(keyId) }, key, sealed);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function importIngestPrivateKey(privateJwk: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", JSON.parse(privateJwk) as JsonWebKey, ECDH, false, ["deriveBits"]);
}

// ---- signatures

/**
 * The signed string: timestamp, method, path and the hex SHA-256 of the body, joined by
 * newlines. Signing the path means a key for one lane cannot be replayed against another.
 */
export const canonicalRequest = (timestamp: string, method: string, path: string, bodySha256Hex: string) =>
  `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodySha256Hex}`;

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/** `sha256=` + hex HMAC-SHA256 of the canonical request. What a client sends as X-Signature. */
export async function signRequest(secret: string, canonical: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), utf8(canonical));
  return `sha256=${toHex(new Uint8Array(mac))}`;
}

/** Constant-time check of an X-Signature header (crypto.subtle.verify). */
export async function verifySignature(secret: string, canonical: string, header: string): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header);
  const mac = match ? fromHex(match[1]!) : null;
  if (!mac) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, utf8(canonical));
}

// ---- storage

export interface IngestKey {
  id: string;
  laneId: string;
  laneSlug: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface IngestKeyRow {
  id: string;
  lane_id: string;
  lane_slug: string;
  secret_box: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const fromRow = (r: IngestKeyRow): IngestKey => ({
  id: r.id,
  laneId: r.lane_id,
  laneSlug: r.lane_slug,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

const SELECT = `SELECT k.id, k.lane_id, l.slug AS lane_slug, k.secret_box, k.created_at, k.last_used_at, k.revoked_at
                FROM ingest_keys k JOIN lanes l ON l.id = k.lane_id`;

export async function getIngestPublicKey(db: Db): Promise<string | null> {
  const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE name = ?", [PUBLIC_KEY_SETTING]);
  return row?.value ?? null;
}

export async function setIngestPublicKey(db: Db, publicJwk: string): Promise<void> {
  await db.run("INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", [
    PUBLIC_KEY_SETTING,
    publicJwk,
  ]);
}

/** Creates a key for a lane and returns its secret. Only the encrypted box is stored, so this is the one chance to see it. */
export async function createIngestKey(db: Db, laneId: string): Promise<{ id: string; secret: string }> {
  const publicJwk = await getIngestPublicKey(db);
  if (!publicJwk) throw new CoreError("Ingest is not set up: run `ingest-keys init` first");
  const active = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM ingest_keys WHERE lane_id = ? AND revoked_at IS NULL", [laneId]);
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS_PER_LANE) {
    throw new CoreError(`A lane can have at most ${MAX_ACTIVE_KEYS_PER_LANE} active keys: revoke one first`);
  }
  const id = `aik_${base32(randomBytes(10))}`;
  const secret = `ais_${base32(randomBytes(32))}`;
  const box = await sealSecret(publicJwk, id, laneId, secret);
  await db.run("INSERT INTO ingest_keys (id, lane_id, secret_box, created_at) VALUES (?, ?, ?, ?)", [
    id,
    laneId,
    box,
    new Date().toISOString(),
  ]);
  return { id, secret };
}

export async function listIngestKeys(db: Db): Promise<IngestKey[]> {
  return (await db.all<IngestKeyRow>(`${SELECT} ORDER BY l.slug, k.created_at`)).map(fromRow);
}

/** The key and its sealed secret, for the Worker. Revoked keys and keys of deleted lanes never match. */
export async function findActiveIngestKey(db: Db, id: string): Promise<(IngestKey & { secretBox: string }) | null> {
  if (!INGEST_KEY_ID_PATTERN.test(id)) return null;
  const row = await db.first<IngestKeyRow>(`${SELECT} WHERE k.id = ? AND k.revoked_at IS NULL`, [id]);
  return row ? { ...fromRow(row), secretBox: row.secret_box } : null;
}

export async function touchIngestKey(db: Db, id: string): Promise<void> {
  await db.run("UPDATE ingest_keys SET last_used_at = ? WHERE id = ?", [new Date().toISOString(), id]);
}

/** Revokes a key. Takes effect on the next request. */
export async function revokeIngestKey(db: Db, id: string): Promise<IngestKey> {
  const row = await db.first<IngestKeyRow>(`${SELECT} WHERE k.id = ?`, [id]);
  if (!row || row.revoked_at) throw new CoreError("Key not found or already revoked");
  await db.run("UPDATE ingest_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [new Date().toISOString(), id]);
  return fromRow(row);
}

/** Revokes every active key, for when the key pair is replaced and old boxes can no longer be opened. */
export async function revokeAllIngestKeys(db: Db): Promise<number> {
  return (await db.run("UPDATE ingest_keys SET revoked_at = ? WHERE revoked_at IS NULL", [new Date().toISOString()])).changes;
}

/** Messages already stored from the API, for ignoring repeats. */
export async function findApiDuplicate(db: Db, laneId: string, messageIdHeader: string, bodySha256: string): Promise<string | null> {
  const row = await db.first<{ id: string }>(
    "SELECT id FROM messages WHERE lane_id = ? AND message_id_header = ? AND body_sha256 = ?",
    [laneId, messageIdHeader, bodySha256],
  );
  return row?.id ?? null;
}
