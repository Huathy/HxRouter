// ─────────────────────────────────────────────────────────────────────────────
// Translator REQUEST-direction byte stability (§5.2 gate 2).
//
// WHAT THIS LOCKS: for a fixed (source, target, model, provider, credentials)
// and a fixed body, `translateRequest` must produce a byte-identical body every
// time it is called. A refactor that starts leaking a fresh `Date.now()`, a
// `randomUUID()` or a `Math.random()` into the upstream request payload — where
// it would silently break prompt caching, ETag/upstream dedup, or replayable
// request fixtures — turns this suite red instead of shipping.
//
// WHY REQUEST-ONLY: the response direction is deliberately NOT tested here.
// `translateResponse` stamps `created: Math.floor(Date.now() / 1000)` and
// message ids like `msg_${Date.now()}` / `chatcmpl-${Date.now()}` /
// `resp_${Date.now()}` (e.g. response/claude-to-openai.js:12,36,
// response/kiro-to-openai.js:68-69, response/gemini-to-openai.js:12,23,49).
// That volatility is required by the SSE protocol — the client is promised a
// fresh timestamp and id per stream — so asserting on it is meaningless.
// Do NOT "helpfully" add response assertions to this file: the response
// direction is covered by golden-response-stream.test.js, which normalises
// exactly those fields (see its stripVolatile()).
//
// REGISTRATION: `translator/index.js` registers every translator via static
// `import` side-effects (~line 247) and `ensureInitialized()` is an empty
// no-op, so importing that module is sufficient. `registerAll.js` is therefore
// NOT imported here and is NOT load-bearing (tests/translator/AGENTS.md §5).
// The first test still asserts the registry is populated — not to guard against
// the old lazy-`require()` false pass, but to catch it if that `require()` ever
// comes back, which would silently make every case below pass untranslated.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { getRequestTranslator } from "../../open-sse/translator/registry.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Every source of entropy a REQUEST translator is allowed to have, each with the
// code that produces it. Anything not matched here shows up as a diff between
// two identical calls — which is the whole point of the ratchet.
// NOTE: tool_call ids are deliberately NOT in this list. ensureToolCallIds mints
// `call_msg{i}_tc{j}_{name}` (concerns/toolCall.js:13-16) precisely so the id is
// cache-friendly and stable; normalising it would hide a real regression.
const VOLATILE = [
  // "[Context: Current time is <ISO>]" — openai-to-kiro.js:484, claude-to-kiro.js:376
  [/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ISO>"],
  // generateRequestId() → `agent-<uuid4>` — formats/gemini.js:118, openai-to-gemini.js:262,297
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>"],
  // generateSessionId() → `<uuid4><epochMs>` — formats/gemini.js:123, and kiro conversationId
  [/<UUID>\d{10,}/g, "<UUID><TS>"],
  // toNumericSessionId() → `-<sha256-derived uint64>` — sessionManager.js:267, openai-to-gemini.js:264,300
  [/("sessionId":")-?\d{10,}/g, "$1<RAND>"],
  // generateProjectId() → `<adj>-<noun>-<5 hex>` — formats/gemini.js:128. Matched by
  // shape, not by copying the word lists, so changing them does not break the test.
  [/"[a-z]+-[a-z]+-[0-9a-f]{5}"/g, '"<PROJECT>"'],
];
const normalize = (value) => {
  let out = JSON.stringify(value);
  for (const [re, to] of VOLATILE) out = out.replace(re, to);
  return out;
};

// OpenAI-shaped source body covering the concerns that break most often:
// system, multi-part content, an image, a tool call with NO id/index
// (exercises ensureToolCallIds' `call_${Date.now()}` path) and its tool_result.
const openaiBody = () => ({
  model: "m",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [
      { type: "text", text: "What's in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,IMGDATA", detail: "high" } },
    ] },
    { role: "assistant", content: "", tool_calls: [
      { type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
    ] },
    { role: "tool", tool_call_id: "call_x", content: "sunny" },
    { role: "user", content: "and tomorrow?" },
  ],
  tools: [{ type: "function", function: { name: "get_weather", description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  temperature: 0.7,
  reasoning_effort: "high",
});

const claudeBody = () => ({
  model: "claude-opus-4-6", max_tokens: 1024, stream: true,
  system: [{ type: "text", text: "You are helpful." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "What's in this image?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "IMGDATA" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "NYC" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }] },
  ],
  tools: [{ name: "get_weather", description: "Get weather",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
});

// One row per registered request route. `creds` is recreated per call because
// translators are allowed to write onto the credentials object.
const MATRIX = [
  { source: FORMATS.OPENAI, target: FORMATS.CLAUDE, model: "claude-opus-4-6", provider: "claude", creds: () => ({ apiKey: "sk-x" }) },
  { source: FORMATS.OPENAI, target: FORMATS.GEMINI, model: "gemini-3-pro", provider: "gemini", creds: () => ({ apiKey: "k" }) },
  { source: FORMATS.OPENAI, target: FORMATS.GEMINI_CLI, model: "gemini-3.1-pro-preview", provider: "gemini-cli", creds: () => ({ accessToken: "t", projectId: "p" }) },
  { source: FORMATS.OPENAI, target: FORMATS.VERTEX, model: "gemini-3-pro", provider: "vertex", creds: () => ({ accessToken: "t", projectId: "p" }) },
  { source: FORMATS.OPENAI, target: FORMATS.ANTIGRAVITY, model: "gemini-3-pro", provider: "antigravity", creds: () => ({ accessToken: "t" }) },
  { source: FORMATS.OPENAI, target: FORMATS.KIRO, model: "claude-sonnet-4.5", provider: "kiro", creds: () => ({ accessToken: "t" }) },
  { source: FORMATS.OPENAI, target: FORMATS.CURSOR, model: "composer", provider: "cursor", creds: () => ({ accessToken: "t" }) },
  { source: FORMATS.OPENAI, target: FORMATS.OLLAMA, model: "qwen3", provider: "ollama", creds: () => ({ apiKey: "" }) },
  { source: FORMATS.OPENAI, target: FORMATS.COMMANDCODE, model: "gpt-5", provider: "commandcode", creds: () => ({ accessToken: "t" }) },
  { source: FORMATS.OPENAI, target: FORMATS.OPENAI_RESPONSES, model: "gpt-5", provider: "openai", creds: () => ({ apiKey: "k" }) },
  { source: FORMATS.CLAUDE, target: FORMATS.OPENAI, model: "gpt-5", provider: "openai", creds: () => ({ apiKey: "k" }), body: claudeBody },
  { source: FORMATS.CLAUDE, target: FORMATS.KIRO, model: "claude-sonnet-4.5", provider: "kiro", creds: () => ({ accessToken: "t" }), body: claudeBody },
];

const run = (row) => translateRequest(
  row.source, row.target, row.model, (row.body ?? openaiBody)(), true, row.creds(), row.provider,
);

describe("translator request byte stability", () => {
  it("every matrix route is registered by index.js's static side-effect imports", () => {
    const missing = MATRIX.filter((r) => !getRequestTranslator(`${r.source}:${r.target}`)).map((r) => `${r.source}->${r.target}`);
    expect(missing, "unregistered route — every case below would pass for the wrong reason (untranslated body)").toEqual([]);
  });

  it.each(MATRIX)("$source -> $target produces identical bytes on repeat calls", (row) => {
    const first = run(row);
    const second = run(row);
    expect(normalize(second), `${row.source} -> ${row.target} is not byte-stable`).toBe(normalize(first));
  });

  it.each(MATRIX)("$source -> $target actually translated the body", (row) => {
    // Guards the other false-pass direction: a no-op that returns the input
    // unchanged would also be "stable", but it would mean the route is dead.
    expect(normalize(run(row))).not.toBe(normalize((row.body ?? openaiBody)()));
  });

  it("the only variance is the known volatile tokens, not real drift", () => {
    // Non-vacuity check: kiro injects "[Context: Current time is <ISO>]" and a
    // random conversationId, so the RAW payloads differ and the normalizer is
    // load-bearing. If these ever matched raw, the ratchet above would pass
    // vacuously.
    const row = MATRIX.find((r) => r.target === FORMATS.KIRO && r.source === FORMATS.OPENAI);
    const a = JSON.stringify(run(row));
    const b = JSON.stringify(run(row));
    expect(a).not.toBe(b);
    expect(normalize(JSON.parse(b))).toBe(normalize(JSON.parse(a)));
    expect(a).toMatch(/Current time is \d{4}-\d{2}-\d{2}T/);
  });

  it("a changed input produces different bytes", () => {
    const row = MATRIX.find((r) => r.target === FORMATS.CLAUDE);
    const call = (body) => normalize(translateRequest(row.source, row.target, row.model, body, true, row.creds(), row.provider));
    const baseline = call(openaiBody());
    expect(call(openaiBody())).toBe(baseline);
    const hotter = openaiBody();
    hotter.temperature = 0.9;
    expect(call(hotter)).not.toBe(baseline);
  });
});
