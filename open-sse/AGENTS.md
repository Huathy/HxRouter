# open-sse

Provider-agnostic SSE engine: one OpenAI-style request → any provider (LLM chat, image, embedding, tts, stt, search), streamed back in the client's format.

## Request lifecycle (chat)

`handlers/chatCore/` (a **directory**, not a single `chatCore.js`; it has no `index.js` — callers import the specific handler module) → `services/model.js` `parseModel` (resolve `provider/model`) → **pre-translate hooks** (`rtk/` tool_result compress, `rtk/contextCompression.js` in-process context compression, `rtk/caveman.js` system inject — all fail-open) → `executors/index.js` `getExecutor(provider)` → `translator/index.js` `translateRequest` (client format → provider format) → `executor.execute()` (streams upstream) → `translateResponse` (provider chunks → client format) → SSE out.

`handlers/chatCore/` contains: `streamingHandler.js`, `nonStreamingHandler.js`, `sseToJsonHandler.js`, `coercedSseHandler.js`, `requestDetail.js`.

## Directory map

- `config/` — ALL constants/config (no hardcode elsewhere). `providers.js`/`registry/` (provider defs), `providerModels.js` (alias→models matrix), `runtimeConfig.js` (timeouts, token limits), `*Constants.js`.
- `translator/` — format conversion. `request/<from>-to-<to>.js`, `response/<from>-to-<to>.js`, `schema/` (enums: ROLE, CLAUDE_BLOCK…), `concerns/` (shared logic), `formats.js`+`formats/` (per-format). `index.js` is the registry/entry.
- `executors/` — per-provider upstream call. `base.js` (BaseExecutor), one file per special provider, `index.js` map.
- `providers/` — registry build + `capabilities.js` + `pricing.js`. Entry: `index.js` (PROVIDERS).
- `handlers/` — per-modality cores (chat/image/embedding/tts/stt/search) + sub-provider folders. `chatCore/` is a directory of the chat handlers (no `index.js`).
- `rtk/` — request token-killer. `index.js` compresses `tool_result` content in-place (OpenAI/Claude/Kiro shapes); `filters/` per-tool compressors + `autodetect.js`; `applyFilter.js`; `contextCompression.js` in-process context compression; `caveman.js` + `cavemanPrompts.js` and `ponytail.js` + `ponytailPrompts.js` system-prompt injectors; `systemInject.js` + `formatInjectors.js`; `pxpipe.js`; `terminationPrompt.js`; `constants.js`.
- `transformer/` — `responsesTransformer.js` (Chat Completions SSE → Codex Responses API SSE), `streamToJsonConverter.js`.
- `shared/` — cross-provider auth/identity: `clineAuth.js`, `machineId.js`, `qoder/`.
- `services/` — `model.js`, `provider.js`, `accountFallback.js`, `combo.js`, `compact.js`, `tokenRefresh/`+`tokenRefresh.js`, `oauthCredentialManager.js`, `usage/`, `projectId.js`, `kiroModels.js`/`qoderModels.js`.
- `utils/` — streamHandler, stream, sse, error, sessionManager, claudeCloaking, clientDetector, proxyFetch (patches global fetch), cursorProtobuf/cursorChecksum, ollamaTransform.

## Conventions

- Config-driven, DRY, camelCase. NEVER hardcode values, models, or block/role strings — use `config/` + `schema/` constants.
- Translator pipeline pivots through OpenAI as the intermediate format. A translator registered on the exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop.
- Translators self-register via `register(from, to, reqFn, resFn)` as an import side-effect — new files MUST be imported in `translator/index.js`. Registration uses **static `import`** statements (~line 247), not lazy `require()`; `ensureInitialized()` is an empty no-op kept for call-site compatibility.

## State ownership

Which layer owns which kind of state. Getting this wrong is the most common source of "why is this value stale / missing".

| State | Owner | Lifetime | Notes |
|---|---|---|---|
| Provider/model registry | `config/providers.js` + `config/registry/` | process | Static, built at import. 145 providers; only 110 have a `transport` block, the other 35 are media providers with `serviceKinds`. |
| Model matrix | `config/providerModels.js` | process | 124 keys, 1,156 models. `strip` / `upstreamModelId` / `targetFormat` live here, not in the registry entry. |
| Translator registry | `translator/index.js` | process | Populated by static import side-effects at module load. |
| Per-request decisions (which provider/combo won, why) | `handlers/chatCore/requestDetail.js` → `requestDetails` table | short | Top-level object, never nested inside `request` — nested payloads get replaced wholesale by `truncateField` when they exceed `maxJsonSize`. |
| Combo rotation state | `services/combo.js` (module-level `Map`) | process | In-memory. Round-robin position and weighted slots; **lost on restart** by design. |
| Circuit breaker / per-provider failure counters | `services/accountFallback.js` + breaker module | process | In-memory, dedup-bounded. Not persisted. |
| OAuth tokens / account credentials | `src/lib/db` (`providerConnections`) + `services/tokenRefresh/` | persistent | `tokenRefresh/` mutates in place and persists through the DB layer. |
| Usage / cost aggregates | `src/lib/db` `usageHistory` + `usageDaily` | persistent | `usageDaily` is one JSON blob per `dateKey`, not a row per request. |
| Config cache (TPS) | `src/lib/settingsRepo` / connections cache | 5s / 2s TTL | Deliberate read cache; invalidated on write. |
| Session affinity | `utils/sessionManager.js` | process | In-memory, TTL-based. No DB table. |

## How to add

- **Provider**: copy `providers/REGISTRY_TEMPLATE.js` → `providers/registry/{id}.js`; add models to `config/providerModels.js`. Generic providers need no executor (DefaultExecutor handles OpenAI-compatible APIs).
- **Executor** (only for non-standard upstream): subclass `BaseExecutor` (override `getBaseUrls`/`buildHeaders`/`buildUrl`/`execute`), register in `executors/index.js` map. `getExecutor` falls back to `DefaultExecutor` when absent.
- **Translator**: add `request|response/<from>-to-<to>.js` calling `register(...)`, then import it in `translator/index.js`. Reuse `schema/` + `concerns/` — don't re-implement parsing.

## Pitfalls

- OpenAI bridge is lossy (thinking, non-base64 images, tool ids, is_error) — prefer a direct route for fragile pairs.
- `registry/index.js` is an auto-generated static import list; regenerate it (don't hand-edit) after adding a `registry/{id}.js`. REGISTRY_TEMPLATE is excluded by design.
- Special binary/protobuf formats (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — handle in their executor.
- `rtk/` + `contextCompression.js` mutate the request body in-place and are **fail-open**: any error returns null and leaves the body untouched — never throw out of them. RTK skips `is_error`/`status:"error"` tool results to preserve traces.
