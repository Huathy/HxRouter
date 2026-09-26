/**
 * Playground usage/cost: the SSE usage parser.
 *
 * Each case below is a failure mode observed in the field, not padding: the
 * usage frame is the only place the Playground can learn what a request cost,
 * and it is the frame most likely to be mangled between the upstream and the
 * browser (nginx/Cloudflare re-chunking, CRLF rewriting, truncation).
 */
import { describe, expect, it } from "vitest";
import { extractUsageFromSSE, usageFromChunk, estimateUsageCost, formatUsageSummary } from "@/shared/utils/sseUsage.js";
import { requestUpstreamUsage } from "@/app/api/dashboard/chat/completions/route.js";

const usageFrame = (usage) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage })}\n\n`;

const textFrame = (content) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content } }] })}\n\n`;

const FULL_USAGE = { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 };

describe("extractUsageFromSSE", () => {
  it("parses a trailing usage chunk (choices empty, sent after all text chunks)", () => {
    const stream = textFrame("Hello") + textFrame(" world") + usageFrame(FULL_USAGE) + "data: [DONE]\n\n";

    const usage = extractUsageFromSSE(stream);

    expect(usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 340,
      total_tokens: 1540,
      cached_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("reads usage attached to a content chunk (the non-OpenAI translator path)", () => {
    // open-sse/translator/response/claude-to-openai.js attaches usage to the
    // LAST content chunk instead of emitting a usage-only frame.
    const frame = `data: ${JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { input_tokens: 900, output_tokens: 120 },
    })}\n\n`;

    const usage = extractUsageFromSSE(frame);

    expect(usage.prompt_tokens).toBe(900);
    expect(usage.completion_tokens).toBe(120);
    // canonicalizeUsage recomputes the total rather than trusting the upstream,
    // because Claude reports input_tokens cache-exclusive.
    expect(usage.total_tokens).toBe(1020);
  });

  it("returns null â€?never 0 and never NaN â€?when the stream carries no usage", () => {
    const stream = textFrame("no usage here") + "data: [DONE]\n\n";

    const usage = extractUsageFromSSE(stream);

    // A missing usage report means "unknown", which must stay distinguishable
    // from a real zero-token request. Collapsing it to 0 would bill the user
    // $0.00 for every request whose upstream simply does not report usage.
    expect(usage).toBeNull();
    expect(usage).not.toBe(0);
    expect(Number.isNaN(usage)).toBe(false);
    expect(estimateUsageCost(usage, { provider: "openai", model: "gpt-5" })).toBe(0);
    expect(formatUsageSummary(usage, { provider: "openai", model: "gpt-5" })).toBe("");
  });

  it("returns null for empty and non-string input", () => {
    expect(extractUsageFromSSE("")).toBeNull();
    expect(extractUsageFromSSE(undefined)).toBeNull();
    expect(extractUsageFromSSE(null)).toBeNull();
    expect(extractUsageFromSSE(42)).toBeNull();
  });

  it("parses a usage chunk that was split across two TCP segments", () => {
    const stream = textFrame("split me") + usageFrame(FULL_USAGE) + "data: [DONE]\n\n";
    // nginx/Cloudflare routinely cut a frame in half; the reader only has the
    // first half at the moment the first read() resolves.
    const cut = stream.indexOf("prompt_tokens") + 4;

    const firstSegment = stream.slice(0, cut);
    const secondSegment = stream.slice(cut);

    // The partial frame is unparseable, so nothing is reported for it yet...
    expect(extractUsageFromSSE(firstSegment)).toBeNull();

    // ...and once the reader re-feeds the full buffer, the usage is found.
    // This is why the parser skips unparseable payloads instead of throwing:
    // the same text is retried on every read.
    const usage = extractUsageFromSSE(firstSegment + secondSegment);
    expect(usage.prompt_tokens).toBe(1200);
    expect(usage.completion_tokens).toBe(340);
    expect(usage.total_tokens).toBe(1540);
  });

  it("keeps a zero-token usage report as zeros and prices it as a finite $0.00", () => {
    // Distinct from the "no usage report" case above: the upstream answered
    // and said "zero tokens". Cost must be a number, not NaN â€?an unknown
    // model id hits the same path and used to be the NaN source.
    const stream = textFrame("empty answer") + usageFrame({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }) + "data: [DONE]\n\n";

    const usage = extractUsageFromSSE(stream);

    expect(usage).not.toBeNull();
    expect(usage.prompt_tokens).toBe(0);
    expect(usage.completion_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);

    const cost = estimateUsageCost(usage, { provider: "openai", model: "gpt-5" });
    expect(Number.isNaN(cost)).toBe(false);
    expect(cost).toBe(0);
    expect(formatUsageSummary(usage, { provider: "openai", model: "gpt-5" })).toBe("0 in Â· 0 out Â· 0 total Â· $0.00");

    // Model with no pricing entry at all: still a finite number.
    const unpriced = estimateUsageCost(usage, { provider: "not-a-provider", model: "not-a-model" });
    expect(Number.isFinite(unpriced)).toBe(true);
    expect(unpriced).toBe(0);
  });

  it("takes the LAST usage chunk, not the first (retry/fallback accounting)", () => {
    // The first frame is the failed attempt that the engine retried; its cost
    // never reached the user. Pinning last-wins keeps the footnote equal to
    // what the caller was actually served.
    const stream = usageFrame({ prompt_tokens: 111, completion_tokens: 11, total_tokens: 122 })
      + textFrame("second attempt")
      + usageFrame({ prompt_tokens: 5000, completion_tokens: 700, total_tokens: 5700 })
      + "data: [DONE]\n\n";

    const usage = extractUsageFromSSE(stream);

    expect(usage.prompt_tokens).toBe(5000);
    expect(usage.completion_tokens).toBe(700);
    expect(usage.total_tokens).toBe(5700);
  });

  it("handles CRLF line endings mixed with the [DONE] sentinel", () => {
    // Reverse proxies rewrite bare \n as \r\n. A parser anchored on the
    // literal "data:" prefix without trimming would silently see zero chunks.
    const stream = textFrame("crlf stream")
      + usageFrame(FULL_USAGE).replace(/\n/g, "\r\n")
      + "data: [DONE]\r\n\r\n";

    const usage = extractUsageFromSSE(stream);

    expect(usage.prompt_tokens).toBe(1200);
    expect(usage.completion_tokens).toBe(340);
    expect(usage.total_tokens).toBe(1540);
  });

  it("handles a lone \\r frame terminator, which the SSE spec also allows", () => {
    // The discriminating CRLF case: with a bare "\n" split the whole stream
    // stays one line, the payload becomes every frame concatenated, and
    // JSON.parse rejects it â€?so usage silently disappears. Proxies that
    // rewrite terminators do produce this.
    const crOnly = `data: ${JSON.stringify({ choices: [], usage: FULL_USAGE })}\r\rdone`;

    expect(extractUsageFromSSE(crOnly).total_tokens).toBe(1540);
  });

  it("handles a single-frame string with no trailing newline", () => {
    expect(extractUsageFromSSE(`data: ${JSON.stringify({ choices: [], usage: FULL_USAGE })}`).total_tokens).toBe(1540);
  });

  it("skips the [DONE] sentinel instead of parsing it (pinned contract)", () => {
    // "data: [DONE]" is OpenAI's end-of-stream marker, not an error and not
    // JSON. The client loop skips it (JSON.parse("[DONE]") throws), and the
    // parser must agree: parsing it would either throw or, if a chunk had
    // already been seen, invite someone to "fix" it into a failure path.
    const stream = textFrame("done soon") + "data: [DONE]\n\n";

    expect(extractUsageFromSSE(stream)).toBeNull();
    // Sentinel-only stream: nothing to report, and no throw.
    expect(extractUsageFromSSE("data: [DONE]\n\n")).toBeNull();
    // Usage before the sentinel still wins â€?the sentinel neither clears nor
    // invalidates what was already collected.
    expect(extractUsageFromSSE(usageFrame(FULL_USAGE) + "data: [DONE]\n\n").total_tokens).toBe(1540);
  });

  it("ignores SSE event/ comment lines and non-JSON keep-alives", () => {
    const stream = ": ping\n\n"
      + "event: message\n"
      + "id: 42\n"
      + textFrame("still works")
      + "data: not-json\n\n"
      + usageFrame(FULL_USAGE);

    expect(extractUsageFromSSE(stream).total_tokens).toBe(1540);
  });
});

describe("estimateUsageCost", () => {
  it("prices a known model and never returns NaN", () => {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, cached_tokens: 0 };

    // gpt-5.3-codex: input 1.75, output 14.00 per 1M tokens.
    const cost = estimateUsageCost(usage, { provider: "openai", model: "gpt-5.3-codex" });
    expect(cost).toBeCloseTo(1.75, 6);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it("subtracts cached tokens from the billable input (cache is a subset)", () => {
    const full = { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000, cached_tokens: 0 };
    const cached = { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000, cached_tokens: 800 };

    const fullCost = estimateUsageCost(full, { provider: "openai", model: "gpt-5.3-codex" });
    const cachedCost = estimateUsageCost(cached, { provider: "openai", model: "gpt-5.3-codex" });

    expect(cachedCost).toBeLessThan(fullCost);
    expect(Number.isFinite(cachedCost)).toBe(true);
  });

  it("returns 0 for a null usage object", () => {
    expect(estimateUsageCost(null, { provider: "openai", model: "gpt-5.3-codex" })).toBe(0);
  });
});

describe("formatUsageSummary", () => {
  it("renders tokens and cost in one line", () => {
    const usage = { prompt_tokens: 12345, completion_tokens: 678, total_tokens: 13023, cached_tokens: 0, cache_creation_input_tokens: 0 };

    const summary = formatUsageSummary(usage, { provider: "openai", model: "gpt-5.3-codex" });

    expect(summary).toContain("12,345 in");
    expect(summary).toContain("678 out");
    expect(summary).toContain("13,023 total");
    expect(summary).toContain("$");
    expect(summary).not.toContain("NaN");
  });

  it("keeps sub-cent costs visible instead of rounding them to $0.00", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cached_tokens: 0, cache_creation_input_tokens: 0 };

    // 100 in + 50 out at gpt-5.3-codex rates â‰?$0.000875.
    expect(formatUsageSummary(usage, { provider: "openai", model: "gpt-5.3-codex" })).toContain("$0.0009");
  });
});

// The parser above is useless if nothing asks the upstream for usage, so the
// request-side half of the fix is asserted here too. Expected values are read
// off the real provider registry via the same resolution the engine uses.
describe("requestUpstreamUsage (playground route injects stream_options)", () => {
  const playgroundBody = (model) => ({ model, messages: [{ role: "user", content: "hi" }], stream: true });

  it("asks OpenAI-format upstreams for usage in the stream", () => {
    for (const model of ["openai/gpt-4o", "openai/gpt-5.3-codex", "openai-compatible-abc123/gpt-4o", "openrouter/deepseek/deepseek-chat"]) {
      expect(requestUpstreamUsage(playgroundBody(model)).stream_options).toEqual({ include_usage: true });
    }
  });

  it("leaves non-OpenAI wire formats alone", () => {
    // Claude/Gemini/Kiro upstreams reject or ignore an unknown field, and their
    // response translators already report usage.
    for (const model of ["anthropic/claude-sonnet-4-6", "gemini-cli/gemini-3-pro", "kiro/claude-sonnet-4-5", "anthropic-compatible-xyz789/claude-3"]) {
      expect(requestUpstreamUsage(playgroundBody(model)).stream_options).toBeUndefined();
    }
  });

  it("skips combos and bare model aliases (target provider is not knowable here)", () => {
    // A combo picks a different provider per attempt at runtime, and a bare
    // alias resolves through the DB alias map: both are "unknown", not "openai".
    expect(requestUpstreamUsage(playgroundBody("combo/my-stack")).stream_options).toBeUndefined();
    expect(requestUpstreamUsage(playgroundBody("grok-build")).stream_options).toBeUndefined();
  });

  it("never overwrites caller-supplied stream_options", () => {
    const out = requestUpstreamUsage({ ...playgroundBody("openai/gpt-4o"), stream_options: { include_usage: false } });
    expect(out.stream_options).toEqual({ include_usage: false });
  });

  it("skips a non-streaming request (usage is already in the response body)", () => {
    const out = requestUpstreamUsage({ ...playgroundBody("openai/gpt-4o"), stream: false });
    expect(out.stream_options).toBeUndefined();
  });

  it("skips a body that is not OpenAI format, so detectFormat() cannot flip", () => {
    // detectFormat() treats a top-level `stream_options` as an OpenAI marker,
    // so injecting it into a Claude-shaped body would reclassify the request.
    const claudeShaped = {
      model: "openai/gpt-4o",
      system: "be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: true,
    };
    expect(requestUpstreamUsage(claudeShaped).stream_options).toBeUndefined();
  });
});

// An SSE read loop already JSON.parses every frame to read the assistant text.
// Routing that parsed frame back through extractUsageFromSSE re-splits the line,
// re-trims, re-slices and re-parses the identical payload ¡ª once per frame of a
// streamed reply. usageFromChunk is the no-re-parse path, and it must be
// observationally identical to extractUsageFromSSE on the same frame.
describe("usageFromChunk", () => {
  const FULL = { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 };

  it("agrees with extractUsageFromSSE on every frame shape the parser handles", () => {
    const frames = [
      { id: "c", object: "chat.completion.chunk", choices: [], usage: FULL },
      { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi" } }], usage: FULL },
      { id: "c", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
      { id: "c", choices: [] },
      { id: "c" },
    ];
    for (const frame of frames) {
      const wire = `data: ${JSON.stringify(frame)}\n\n`;
      expect(usageFromChunk(frame)).toEqual(extractUsageFromSSE(wire));
    }
  });

  it("returns null ¡ª never 0, never NaN ¡ª for a frame with no usage report", () => {
    expect(usageFromChunk({ id: "c", choices: [] })).toBeNull();
    expect(usageFromChunk({ usage: null })).toBeNull();
  });

  it("keeps a genuinely zero-token report as zeros, not as the unknown case", () => {
    const zero = usageFromChunk({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    expect(zero).toMatchObject({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("tolerates a non-object argument instead of throwing", () => {
    for (const bad of [null, undefined, 0, "", "data: {}", []]) {
      expect(usageFromChunk(bad)).toBeNull();
    }
  });
});
