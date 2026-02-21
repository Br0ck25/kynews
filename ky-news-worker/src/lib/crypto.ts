import type { Env } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedSecret = "";
let cachedKeyPromise: Promise<CryptoKey> | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function fromBase64(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function getEncryptionKey(secret: string): Promise<CryptoKey> {
  if (!cachedKeyPromise || cachedSecret !== secret) {
    cachedSecret = secret;
    cachedKeyPromise = crypto.subtle
      .digest("SHA-256", encoder.encode(secret))
      .then((hash) => crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
  }
  return cachedKeyPromise;
}

export async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function stableHash(input: string): Promise<string> {
  return sha256Hex(input);
}

export async function makeItemId(input: {
  url: string;
  guid?: string | null;
  title?: string | null;
  published_at?: string | null;
}): Promise<string> {
  const base = input.url || input.guid || `${input.title || ""}__${input.published_at || ""}`;
  const hash = await stableHash(base);
  return hash.slice(0, 24);
}

async function tryDecrypt(key: CryptoKey, iv: Uint8Array, cipherAndTag: Uint8Array): Promise<string | null> {
  try {
    const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, cipherAndTag);
    return decoder.decode(out);
  } catch {
    return null;
  }
}

export async function encryptText(env: Env, value: string): Promise<string> {
  const secret = env.DATA_ENCRYPTION_KEY || "dev-only-change-me";
  const key = await getEncryptionKey(secret);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, encoder.encode(String(value)))
  );

  const tag = encrypted.slice(encrypted.length - 16);
  const cipher = encrypted.slice(0, encrypted.length - 16);

  const packed = new Uint8Array(12 + 16 + cipher.length);
  packed.set(iv, 0);
  packed.set(tag, 12);
  packed.set(cipher, 28);

  return toBase64(packed);
}

export async function decryptText(env: Env, cipherText: string | null | undefined): Promise<string | null> {
  if (!cipherText) return null;

  try {
    const data = fromBase64(String(cipherText));
    if (data.length < 28) return null;

    const secret = env.DATA_ENCRYPTION_KEY || "dev-only-change-me";
    const key = await getEncryptionKey(secret);

    const iv = data.slice(0, 12);

    // Legacy node format: iv(12) + tag(16) + cipher
    const tag = data.slice(12, 28);
    const cipher = data.slice(28);
    const legacyPayload = new Uint8Array(cipher.length + tag.length);
    legacyPayload.set(cipher, 0);
    legacyPayload.set(tag, cipher.length);

    const legacy = await tryDecrypt(key, iv, legacyPayload);
    if (legacy != null) return legacy;

    // Alternate format: iv(12) + cipher+tag
    const alt = await tryDecrypt(key, iv, data.slice(12));
    return alt;
  } catch {
    return null;
  }
}

export async function hashIp(ip: string): Promise<string> {
  return sha256Hex(ip);
}
