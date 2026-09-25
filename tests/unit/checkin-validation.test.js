import { describe, expect, it } from "vitest";
import { normalizeCheckinScriptInput, redactCheckinConfig } from "../../src/lib/checkin/validation.js";

const validInput = {
  name: "Example daily check-in",
  enabled: true,
  scheduleType: "cron",
  cronExpr: "0 8 * * *",
  timezone: "Asia/Shanghai",
  config: {
    url: "https://example.com/api/check-in",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer {{secret}}",
    },
    body: '{"date":"{{date}}"}',
    expectedStatus: [200],
    successPattern: "success|已签到|already",
    timeoutSeconds: 30,
  },
  secret: "secret-token",
  secretAction: "replace",
};

describe("checkin script validation", () => {
  it("normalizes a valid declarative HTTP check-in", () => {
    const result = normalizeCheckinScriptInput(validInput);
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      name: "Example daily check-in",
      enabled: true,
      scheduleType: "cron",
      cronExpr: "0 8 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(result.value.config.method).toBe("POST");
    expect(result.value.config.expectedStatus).toEqual([200]);
  });

  it("rejects credentials embedded in the URL", () => {
    const result = normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, url: "https://user:pass@example.com/check-in" },
    });
    expect(result.error).toBe("URL must not include credentials");
  });

  it("requires sensitive headers to reference the encrypted secret", () => {
    const result = normalizeCheckinScriptInput({
      ...validInput,
      config: {
        ...validInput.config,
        headers: { Authorization: "Bearer plaintext-token" },
      },
    });
    expect(result.error).toBe("Sensitive headers must use {{secret}}");
  });

  it("rejects mixed plaintext and placeholder secret values", () => {
    expect(normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, url: "https://example.com/check-in?token=abc{{secret}}def" },
    }).error).toBe("Sensitive URL parameters must use {{secret}}");
    expect(normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, headers: { "X-Auth": "prefix-{{secret}}-suffix" } },
    }).error).toBe("Sensitive headers must use {{secret}}");
  });

  it("rejects plaintext secrets in URL and body fields", () => {
    expect(normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, url: "https://example.com/check-in?token=plaintext" },
    }).error).toBe("Sensitive URL parameters must use {{secret}}");
    expect(normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, body: '{"token":"plaintext"}' },
    }).error).toBe("Sensitive request body values must use {{secret}}");
    expect(normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, url: "https://example.com/api/token-real" },
    }).error).toBe("Sensitive URL path values must use {{secret}}");
  });

  it("redacts sensitive configuration values for API responses", () => {
    const redacted = redactCheckinConfig({
      url: "https://example.com/check-in?token=plaintext",
      headers: { Authorization: "Bearer plaintext" },
      body: '{"value":"REALTOKEN"}',
    });

    expect(redacted.url).not.toContain("plaintext");
    expect(redacted.url).toContain("token={{secret}}");
    expect(redacted.headers.Authorization).toBe("{{secret}}");
    expect(redacted.body).toBe("");
    expect(redacted.bodyOmitted).toBe(true);
  });

  it("preserves date and secret templates in URL paths and queries", () => {
    const redacted = redactCheckinConfig({
      url: "https://example.com/{{date}}?token=plaintext",
      headers: {},
    });

    expect(redacted.url).toBe("https://example.com/{{date}}?token={{secret}}");
  });

  it("rejects unsupported methods and oversized bodies", () => {
    expect(normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, method: "CONNECT" },
    }).error).toBe("Unsupported HTTP method");
    expect(normalizeCheckinScriptInput({
      ...validInput,
      config: { ...validInput.config, body: "x".repeat(32769) },
    }).error).toBe("Request body is too large");
  });
});
