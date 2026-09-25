import { parseCheckinCron } from "./cron.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_HEADER = /authorization|cookie|token|secret|api[-_]?key|password|session|auth|credential|csrf/i;
const SENSITIVE_FIELD = /authorization|cookie|token|secret|api[-_]?key|password|session|auth|credential|csrf/i;
const SENSITIVE_ASSIGNMENT = /(?:token|secret|api[-_]?key|authorization|cookie|password|session|auth|credential|csrf)\s*["']?\s*[:=]\s*["']?(?!\{\{secret\}\})/i;
const SENSITIVE_PATH = /(?:token|secret|api[-_]?key|auth|credential|password|session|csrf)[=:_-]/i;

function isSecretTemplate(value) {
  const text = String(value || "").trim();
  return text === "{{secret}}" || /^(?:Bearer|Token)\s+\{\{secret\}\}$/i.test(text) || /^(?:session|token|api[_-]?key)=\s*\{\{secret\}\}$/i.test(text);
}

function containsPlaintextSecret(value, key = "") {
  if (typeof value !== "string") return false;
  if (SENSITIVE_FIELD.test(key) && value && !isSecretTemplate(value)) return true;
  if (SENSITIVE_ASSIGNMENT.test(value)) return true;
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(redactJsonValue(parsed)) !== JSON.stringify(parsed);
  } catch {
    return false;
  }
}

function redactJsonValue(value, key = "") {
  if (typeof value === "string" && SENSITIVE_FIELD.test(key) && value && !isSecretTemplate(value)) return "{{secret}}";
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactJsonValue(entryValue, entryKey)]));
  }
  return value;
}

export function redactCheckinConfig(config = {}) {
  const url = typeof config.url === "string" ? config.url : "";
  const protectedUrl = url.replace(/\{\{(date|secret)\}\}/gi, "__HX_TEMPLATE_$1__");
  let safeUrl = protectedUrl;
  try {
    const parsed = new URL(protectedUrl);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (SENSITIVE_FIELD.test(key) && value && !isSecretTemplate(value)) parsed.searchParams.set(key, "{{secret}}");
    }
    safeUrl = parsed.toString()
      .replace(/%7B%7B(secret|date)%7D%7D/gi, "{{$1}}")
      .replace(/__HX_TEMPLATE_(DATE|SECRET)__/gi, "{{$1}}")
      .replace(/((?:token|secret|api[-_]?key|auth|credential|password|session|csrf)[=:_-])[^/?#&]+/gi, "$1{{secret}}");
  } catch {
    safeUrl = protectedUrl.replace(SENSITIVE_ASSIGNMENT, (match) => `${match}{{secret}}`);
  }
  const headers = Object.fromEntries(Object.entries(config.headers || {}).map(([key, value]) => [
    key,
    SENSITIVE_FIELD.test(key) && String(value) && !isSecretTemplate(value) ? "{{secret}}" : value,
  ]));
  return {
    url: safeUrl,
    method: config.method || "GET",
    headers,
    body: "",
    bodyOmitted: true,
    expectedStatus: Array.isArray(config.expectedStatus) ? config.expectedStatus : [200],
    successPattern: config.successPattern || "",
    timeoutSeconds: Number.isInteger(config.timeoutSeconds) ? config.timeoutSeconds : 30,
  };
}

function errorResult(error) {
  return { error };
}

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeCheckinScriptInput(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) return errorResult("Name is required and must be at most 100 characters");

  const enabled = input.enabled === true;
  const scheduleType = input.scheduleType === "manual" ? "manual" : "cron";
  const cronExpr = typeof input.cronExpr === "string" ? input.cronExpr.trim() : "";
  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : "UTC";
  if (scheduleType === "cron") {
    const parsed = parseCheckinCron(cronExpr);
    if (!parsed.ok) return errorResult(parsed.error);
  }
  if (!validTimezone(timezone)) return errorResult("Invalid timezone");

  const source = input.config && typeof input.config === "object" ? input.config : {};
  const url = typeof source.url === "string" ? source.url.trim() : "";
  if (!url || url.length > 2048) return errorResult("URL is required and must be at most 2048 characters");
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return errorResult("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) return errorResult("URL must use HTTP or HTTPS");
  if (parsedUrl.username || parsedUrl.password) return errorResult("URL must not include credentials");
  const pathAndHash = `${parsedUrl.pathname}${parsedUrl.hash}`;
  if (SENSITIVE_PATH.test(pathAndHash) && !pathAndHash.includes("{{secret}}")) {
    return errorResult("Sensitive URL path values must use {{secret}}");
  }
  for (const [key, value] of parsedUrl.searchParams.entries()) {
    if (SENSITIVE_FIELD.test(key) && value && !isSecretTemplate(value)) {
      return errorResult("Sensitive URL parameters must use {{secret}}");
    }
  }

  const method = typeof source.method === "string" ? source.method.toUpperCase() : "GET";
  if (!METHODS.has(method)) return errorResult("Unsupported HTTP method");

  const headers = {};
  if (source.headers && typeof source.headers === "object" && !Array.isArray(source.headers)) {
    for (const [rawName, rawValue] of Object.entries(source.headers)) {
      const headerName = String(rawName).trim();
      const headerValue = String(rawValue ?? "").trim();
      if (!headerName || headerName.length > 128 || /[\r\n]/.test(headerName)) return errorResult("Invalid header name");
      if (!headerValue || headerValue.length > 4096 || /[\r\n]/.test(headerValue)) return errorResult("Invalid header value");
      if (SENSITIVE_HEADER.test(headerName) && !isSecretTemplate(headerValue)) {
        return errorResult("Sensitive headers must use {{secret}}");
      }
      headers[headerName] = headerValue;
    }
  } else if (source.headers !== undefined) {
    return errorResult("Headers must be an object");
  }

  const body = source.body == null ? "" : typeof source.body === "string" ? source.body : JSON.stringify(source.body);
  if (typeof body !== "string" || body.length > 32768) return errorResult("Request body is too large");
  if (containsPlaintextSecret(body)) return errorResult("Sensitive request body values must use {{secret}}");

  const expectedStatus = Array.isArray(source.expectedStatus) ? source.expectedStatus : [200];
  if (
    expectedStatus.length < 1 ||
    expectedStatus.length > 10 ||
    expectedStatus.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
  ) return errorResult("Expected status must contain valid HTTP status codes");

  const successPattern = typeof source.successPattern === "string" ? source.successPattern.trim() : "";
  if (successPattern.length > 500) return errorResult("Success pattern is too long");
  if (successPattern) {
    try {
      new RegExp(successPattern, "i");
    } catch {
      return errorResult("Success pattern is invalid");
    }
  }

  const timeoutSeconds = Number.isInteger(source.timeoutSeconds) ? source.timeoutSeconds : 30;
  if (timeoutSeconds < 1 || timeoutSeconds > 120) return errorResult("Timeout must be between 1 and 120 seconds");

  const secret = typeof input.secret === "string" ? input.secret : "";
  if (secret.length > 16384) return errorResult("Secret is too large");
  const secretAction = ["keep", "replace", "clear"].includes(input.secretAction) ? input.secretAction : "keep";
  if (secretAction === "replace" && !secret) return errorResult("Secret is required");

  return {
    value: {
      name,
      enabled,
      scheduleType,
      cronExpr: scheduleType === "cron" ? cronExpr : "",
      timezone,
      config: {
        url,
        method,
        headers,
        body,
        bodyOmitted: source.bodyOmitted === true,
        expectedStatus,
        successPattern,
        timeoutSeconds,
      },
      secret,
      secretAction,
    },
  };
}
