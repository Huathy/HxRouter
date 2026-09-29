// Forward provider rate-limit headers to the client so it can back off on its own.
// Without this the client only sees our generic error and cannot know when to retry.

const FORWARDED = [
  "retry-after",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-input-tokens-limit",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-limit",
  "anthropic-ratelimit-output-tokens-remaining",
  "anthropic-ratelimit-output-tokens-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-unified-status",
  "anthropic-ratelimit-unified-reset"
];

/**
 * Extract forwarded rate-limit headers from an upstream fetch Response.
 * @param {Response|Headers|null|undefined} upstream
 * @returns {Record<string, string>} empty object when nothing is forwarded
 */
export function upstreamResponseHeaders(upstream) {
  if (!upstream) return {};
  const source = upstream instanceof Headers ? upstream : upstream.headers;
  if (!source || typeof source.get !== "function") return {};

  const headers = {};
  for (const name of FORWARDED) {
    const value = source.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}
