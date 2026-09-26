import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { parseModel } from "open-sse/services/model.js";
import { detectFormat, getTargetFormat, resolveTransport } from "open-sse/services/provider.js";
import { getModelTargetFormat, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { FORMATS } from "open-sse/translator/formats.js";

const CLI_TOKEN_SALT = "9r-cli-auth";
const CLI_TOKEN_HEADER = "x-9r-cli-token";
const COMBO_PREFIX = "combo/";

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
 * Resolve the upstream wire format this request will be translated to.
 *
 * Deliberately mirrors handleChatCore's own resolution order
 * (open-sse/handlers/chatCore.js: useTransport?.format || modelTargetFormat
 * || getTargetFormat) instead of guessing from the provider name, so this
 * route can never disagree with the engine about which format is on the wire.
 *
 * Returns null whenever the answer is not knowable here (combo routing picks a
 * different provider per attempt at runtime; a bare model alias resolves its
 * provider through the DB alias map). Callers must treat null as "unknown" and
 * not act on it.
 */
function resolveTargetFormat(modelStr) {
  if (typeof modelStr !== "string" || !modelStr) return null;
  if (modelStr.startsWith(COMBO_PREFIX)) return null;

  const { provider, model, isAlias } = parseModel(modelStr);
  if (isAlias || !provider || !model) return null;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  return resolveTransport(provider, FORMATS.OPENAI)?.format
    || getModelTargetFormat(alias, model)
    || getTargetFormat(provider);
}

/**
 * Ask an OpenAI-format upstream to report usage in its stream.
 *
 * `stream_options.include_usage` is a Chat Completions field, and it has to be
 * set on the body that leaves the browser because no request translator can
 * add it: when source format === target format the whole translation step is
 * skipped (open-sse/translator/index.js — there is no openai→openai
 * translator), so for OpenAI-compatible upstreams this route is the only place
 * the field can be injected. The `*-to-openai` *response* translators
 * (e.g. open-sse/translator/response/claude-to-openai.js) do the opposite
 * job: they attach usage the upstream already reported to the last chunk.
 *
 * Boundaries:
 * - Streaming only. A non-streaming reply carries usage in the response body,
 *   so the field would be meaningless there.
 * - OpenAI-format upstreams only. Claude/Gemini/Kiro/... either reject the
 *   unknown field or silently drop it, and those providers already surface
 *   usage through their own response translators, so injecting would buy
 *   nothing at the cost of a 400.
 * - The caller's own `stream_options` is never overwritten.
 * - The detected source format must already be OpenAI: detectFormat() treats
 *   `stream_options` itself as an OpenAI marker, so injecting it into a
 *   non-OpenAI body would silently reclassify the request.
 */
// Exported for tests: the inject/skip decision is the whole point of the fix
// and must be provable without booting Next (see tests/unit/playground-usage.test.js).
export function requestUpstreamUsage(body) {
  if (body?.stream === false) return body;
  if (body?.stream_options) return body;
  if (detectFormat(body) !== FORMATS.OPENAI) return body;
  if (resolveTargetFormat(body.model) !== FORMATS.OPENAI) return body;
  return { ...body, stream_options: { include_usage: true } };
}

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
      body: JSON.stringify(requestUpstreamUsage({ ...body, stream: true })),
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
  // Forward the canonical HxRouter selected-connection header, with a legacy read fallback.
  const selectedConn = upstream.headers.get("x-hxrouter-selected-connection-id")
    || upstream.headers.get("x-vansroute-selected-connection-id");
  if (selectedConn) responseHeaders["x-hxrouter-selected-connection-id"] = selectedConn;

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
