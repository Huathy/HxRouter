import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptCheckinSecret, encryptCheckinSecret, isCheckinSecretEncryptionAvailable } from "../../src/lib/checkin/secretCrypto.js";

const originalKey = process.env.AUTOMATION_SECRET_KEY;

beforeEach(() => {
  process.env.AUTOMATION_SECRET_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.AUTOMATION_SECRET_KEY;
  else process.env.AUTOMATION_SECRET_KEY = originalKey;
});

describe("checkin secret encryption", () => {
  it("encrypts and decrypts with AES-GCM", () => {
    const encrypted = encryptCheckinSecret("cookie-value");
    expect(encrypted).not.toContain("cookie-value");
    expect(decryptCheckinSecret(encrypted)).toBe("cookie-value");
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptCheckinSecret("cookie-value");
    expect(() => decryptCheckinSecret(`${encrypted.slice(0, -1)}x`)).toThrow();
  });

  it("reports unavailable encryption without a valid key", () => {
    delete process.env.AUTOMATION_SECRET_KEY;
    expect(isCheckinSecretEncryptionAvailable()).toBe(false);
  });
});
