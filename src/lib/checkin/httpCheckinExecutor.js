import { guardedFetchWithConsumer } from "@/shared/utils/ssrfGuard.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const PREVIEW_LIMIT = 4096;

function substitute(value, secret, dateValue) {
  return String(value ?? "")
    .replaceAll("{{secret}}", secret || "")
    .replaceAll("{{date}}", dateValue);
}

function getLocalDate(timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function redactCheckinText(value, secret) {
  let text = String(value ?? "");
  if (secret) {
    const variants = [...new Set([
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(encodeURIComponent(secret)),
      JSON.stringify(secret).slice(1, -1),
    ])].filter(Boolean);
    for (const variant of variants) text = text.split(variant).join("[REDACTED]");
  }
  return text.slice(0, PREVIEW_LIMIT);
}

async function readResponseText(response) {
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      const error = new Error("Response body is too large");
      error.code = "RESPONSE_TOO_LARGE";
      throw error;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function failure(errorCode, message, extra = {}) {
  return { success: false, errorCode, errorMessage: message, ...extra };
}

export async function executeHttpCheckin({ config, secret = "", timezone = "UTC" }, { fetchImpl } = {}) {
  const dateValue = getLocalDate(timezone);
  const url = substitute(config?.url, secret, dateValue);
  const method = String(config?.method || "GET").toUpperCase();
  const headers = Object.fromEntries(
    Object.entries(config?.headers || {}).map(([name, value]) => [name, substitute(value, secret, dateValue)]),
  );
  const body = method === "GET" ? undefined : substitute(config?.body, secret, dateValue);
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(120, Number(config?.timeoutSeconds) || 30)) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestOptions = {
      method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    };
    let status;
    let responseText;
    if (fetchImpl) {
      const response = await fetchImpl(url, requestOptions);
      status = response.status;
      responseText = await readResponseText(response);
    } else {
      const response = await guardedFetchWithConsumer(url, requestOptions, async (result) => ({
        status: result.status,
        text: await readResponseText(result),
      }));
      status = response.status;
      responseText = response.text;
    }
    const responsePreview = redactCheckinText(responseText, secret);
    const expectedStatus = Array.isArray(config?.expectedStatus) && config.expectedStatus.length > 0
      ? config.expectedStatus
      : [200];
    const statusMatches = expectedStatus.includes(status);
    const pattern = String(config?.successPattern || "").trim();
    const patternMatches = !pattern || new RegExp(pattern, "i").test(responseText);

    if (!statusMatches) {
      return failure("UNEXPECTED_STATUS", `HTTP ${status}`, { httpStatus: status, responsePreview });
    }
    if (!patternMatches) {
      return failure("UNEXPECTED_RESPONSE", "Response did not match the success pattern", { httpStatus: status, responsePreview });
    }
    return {
      success: true,
      httpStatus: status,
      summary: `HTTP ${status}`,
      responsePreview,
    };
  } catch (error) {
    if (error?.code === "RESPONSE_TOO_LARGE") {
      return failure("RESPONSE_TOO_LARGE", "Response body exceeded 256 KiB");
    }
    if (controller.signal.aborted) {
      return failure("TIMED_OUT", `Request exceeded ${Math.round(timeoutMs / 1000)} seconds`);
    }
    if (String(error?.message || "").startsWith("Blocked URL:")) {
      return failure("BLOCKED_URL", "The target URL is blocked by the SSRF guard");
    }
    return failure("REQUEST_FAILED", "The check-in request failed");
  } finally {
    clearTimeout(timeout);
  }
}
