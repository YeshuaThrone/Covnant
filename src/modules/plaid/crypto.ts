// Plaid token crypto — Cursor's Phase 2 re-drop (sandbox AES-256-GCM access
// token encryption). Store-free; byte-exact from the drop.

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { PLAID_TOKEN_ENC_PREFIX } from "@/modules/don/constants";

const SANDBOX_KEY_MATERIAL = "don-engine-sandbox-plaid-token-key";

export function plaidEncryptionKey(): Buffer {
  const fromEnv = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  const material =
    typeof fromEnv === "string" && fromEnv.trim() !== ""
      ? fromEnv.trim()
      : SANDBOX_KEY_MATERIAL;
  return createHash("sha256").update(material).digest();
}

export function isEncryptedAccessToken(token: string): boolean {
  return token.startsWith(PLAID_TOKEN_ENC_PREFIX); // "enc:v1:"
}

export function encryptAccessToken(plaintext: string, iv: Buffer = randomBytes(12)): string {
  const cipher = createCipheriv("aes-256-gcm", plaidEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PLAID_TOKEN_ENC_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}
