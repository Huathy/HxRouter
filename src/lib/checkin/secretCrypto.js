import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getKey() {
  const raw = process.env.AUTOMATION_SECRET_KEY;
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function isCheckinSecretEncryptionAvailable() {
  return getKey() !== null;
}

export function encryptCheckinSecret(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("Secret is required");
  const key = getKey();
  if (!key) throw new Error("Secret encryption is unavailable");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptCheckinSecret(value) {
  if (typeof value !== "string") throw new Error("Encrypted secret is invalid");
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) throw new Error("Encrypted secret is invalid");
  const key = getKey();
  if (!key) throw new Error("Secret encryption is unavailable");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
