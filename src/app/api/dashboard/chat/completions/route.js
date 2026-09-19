import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";

const CLI_TOKEN_SALT = "9r-cli-auth";
const CLI_TOKEN_HEADER = "x-9r-cli-token";

// ponytail: memoize token+port — machine-bound secret and port are process-stable.
let _cliTokenPromise = null;
const getCliToken = () => {
  if (!_cliTokenPromise) _cliTokenPromise = getConsistentMachineId(CLI_TOKEN_SALT);
  return _cliTokenPromise;
};

const resolveBaseUrl = () => {
  const port = process.env.PORT || UPDATER_CONFIG.appPort;
  return `http://127.0.0.1:${port}`;
};

/**
 * Dashboard Playground proxy → /api/v1/chat/completions
 *
 * Injects the machine-bound CLI token so the trusted-internal gate in
 * src/sse/handlers/chat.js bypasses per-API-key ACL. The browser cannot
 * read this token; only server-side code can. Dashboard auth (JWT/cookie)
 * is enforced by dashboardGuard before this route runs.
 *
 * SSE passthrough: returns upstream.body ReadableStream directly so the
 * client can render chunks incrementally (see BasicChatPageClient reader loop).
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
  };

  const token = await getCliToken();
  if (token) headers[CLI_TOKEN_HEADER] = token;

  try {
    const keys = await getApiKeys();
    const key = keys.find((k) => k.isActive !== false)?.key;
    if (key) headers["Authorization"] = `Bearer ${key}`;
  } catch {
    // No API keys configured — trusted-internal token alone is sufficient.
  }

  let upstream;
  try {
    upstream = await fetch(`${resolveBaseUrl()}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal: request.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return Response.json({ error: `Upstream unreachable: ${error.message}` }, { status: 502 });
  }

  const responseHeaders = {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };
  // Forward X-VansRoute-Selected-Connection-Id if present (debugging aid).
  const selectedConn = upstream.headers.get("x-vansroute-selected-connection-id");
  if (selectedConn) responseHeaders["x-vansroute-selected-connection-id"] = selectedConn;

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
