/**
 * Per-API-key daily spend budget gate.
 *
 * Problem it solves: a 402 "insufficient credit" from an upstream provider is not
 * a terminal error (open-sse/config/errorConfig.js has no `shouldFallback: false`
 * for 402), so the request loop keeps walking the fallback chain and burns an
 * attempt (and possibly a real token spend) per target. This module stops the
 * request BEFORE the first upstream dispatch, with a client-visible 402.
 *
 * ── Storage ────────────────────────────────────────────────────────────────
 * One row in the existing `kv` table (PRIMARY KEY (scope, key)):
 *     scope = 'budget'
 *     key   = '<YYYY-MM-DD>:<apiKeyId>'      (UTC date, apiKeys.id or '__local__')
 *     value = '{"s":<committedCents>,"p":{"<resId>":{"c":<cents>,"t":<epochMs>}}}'
 *
 * `s` = settled + committed cents for the UTC day. `p` = in-flight pre-authorizations
 * (reserved before dispatch, not yet settled). A new kv row is NOT a schema change,
 * so no migration is required. `usageDaily` is deliberately NOT used: it is one JSON
 * blob per dateKey with no JSON functions, so a per-key sum would mean parsing and
 * scanning the whole day (and the sql.js adapter re-persists the whole DB per write).
 *
 * ── Reserve formula (worst-case pre-authorization) ──────────────────────────
 *   promptTokens = ceil(promptChars / 4)              4 chars/token, the repo-wide
 *                                                     convention (muse-spark-web.js:100)
 *   outputTokens = clamp(max_tokens|max_completion_tokens|max_output_tokens,
 *                        256, DEFAULT_MAX_TOKENS) or 4096 when the client omits it
 *   reserveCents = ceil((promptTokens * inputRate + outputTokens * outputRate)
 *                       / 1e6 * 100)                  rates are $/1M, from
 *                                                     open-sse/providers/pricing.js
 *   reserveCents = max(1, reserveCents)
 *
 * `outputTokens` is deliberately NOT open-sse/shared/constants/providers.js:57
 * `defaultBudgetTokens: 10000`. That is a *thinking* budget (reasoning tokens), not
 * an output cap; pricing it as output would reserve $0.15/request on claude-sonnet
 * and falsely exhaust a $1 budget after ~6 requests. 4096 is the classic OpenAI
 * default output cap, so it is the right order of magnitude for "client said nothing".
 *
 * Known conservatism, stated rather than hidden:
 *  - A request is charged its WORST case, not its actual cost. A large max_tokens on
 *    an expensive model can therefore consume an entire daily budget on one request.
 *    That is the correct behaviour for a cap; a meter would need the usage recorder,
 *    which lives below this layer.
 *  - An unpriced model (custom OpenAI-compatible node, provider alias used as a
 *    "model" by the search/fetch handlers) falls back to the highest rate in the
 *    pricing table, so it over-reserves.
 *  - Modality pricing other than `llm` (image / tts / webSearch / webFetch) is
 *    per-call upstream, not per-token, and this repo has no per-call rates. Those
 *    modalities reserve input cost only (outputTokens = 0) and bottom out at
 *    MIN_RESERVE_CENTS = 1, so they are gated loosely by design.
 *
 * ── fail-closed vs fail-open ───────────────────────────────────────────────
 *  - Budget DISABLED (no limit configured)  -> fail-OPEN:  no DB access at all,
 *    behaviour is byte-identical to today. This is the default, so the feature is
 *    opt-in and cannot break existing deployments or tests.
 *  - Budget ENABLED and the counter cannot be read/written -> fail-CLOSED: 402.
 *    The entire purpose of the gate is to stop unbounded spend; a gate that fails
 *    open on a DB error is not a gate. Spend is still capped by the upstream
 *    provider's own 402, which is the failure we are working around, so failing
 *    closed is strictly safer.
 *
 * ── settle-failure compensation (no stranded reservation) ──────────────────
 * settleSpend() swallows its own errors: if the settle write fails the pending
 * entry survives, and the next reserveSpend() for the same key sweeps it
 * (PENDING_TTL_MS) by COMMITTING it, never by deleting it. So a failed settle costs
 * at most one reservation, once, and it is charged exactly once — the user can never
 * be blocked by a reservation that can neither be settled nor released. The sweep
 * needs no timer and no new lifecycle: it runs inside the next reserve transaction,
 * so a reservation is reclaimed by the very next request from that key.
 */
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { getPricingForModel, MODEL_PRICING } from "open-sse/providers/pricing.js";
import { HTTP_STATUS, DEFAULT_MAX_TOKENS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

const BUDGET_SCOPE = "budget";

// settingsRepo.js:20 defaults requireApiKey to false, so apiKeyInfo is routinely
// null (local / trusted-internal mode). Local spend still needs a bucket, otherwise
// __local__ traffic would be unmetered.
const LOCAL_KEY_ID = "__local__";

const CHARS_PER_TOKEN = 4;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 4096;
const MIN_OUTPUT_RESERVE_TOKENS = 256;
const MAX_OUTPUT_RESERVE_TOKENS = DEFAULT_MAX_TOKENS;
const MIN_RESERVE_CENTS = 1;

const DEFAULT_PENDING_TTL_MS = 10 * 60_000;

// Body fields that carry the billable prompt, per modality. Field names differ per
// handler on purpose: the search/fetch handlers have no `model` prompt at all.
//
// Every modality that can reach an upstream billable call MUST appear here, or
// `estimatePromptChars` silently falls back to the llm field list, measures
// nothing, and the gate bottoms out at MIN_RESERVE_CENTS for a request that
// costs real money. `stt` is a multipart FormData, not a plain object, so a
// field-name walk cannot measure it: it is listed explicitly with no fields so
// the loose-gate behaviour is a stated decision rather than an accident.
const PROMPT_FIELDS = {
  llm: ["messages", "input", "system", "tools"],
  embedding: ["input"],
  image: ["prompt"],
  tts: ["input"],
  stt: [],
  video: ["prompt"],
  webSearch: ["query"],
  webFetch: ["url", "max_characters"],
};

// Only llm is billed per token by anything this repo can price.
const TOKEN_BILLED_MODALITIES = new Set(["llm"]);

// Highest rate present in the pricing table, so an unpriced model over-reserves
// instead of silently escaping the budget.
const FALLBACK_PRICING = Object.values(MODEL_PRICING).reduce(
  (acc, p) => ({ input: Math.max(acc.input, p.input || 0), output: Math.max(acc.output, p.output || 0) }),
  { input: 0, output: 0 }
);

function pendingTtlMs() {
  const n = Number(process.env.SPEND_BUDGET_PENDING_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PENDING_TTL_MS;
}

function newReservationId() {
  return globalThis.crypto?.randomUUID?.() || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** UTC day bucket. Matches the "until tomorrow 00:00 UTC" convention used for daily quota locks. */
export function budgetDateKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * 64-bit FNV-1a fingerprint of a raw key. Used only when `apiKeyInfo` is absent
 * (requireApiKey=false, settingsRepo.js:20) but the client still presented a key:
 * without this every such request lands in the `__local__` bucket, so an identified
 * client spends against the local allowance. `apiKeys.key` is already persisted in
 * plaintext (schema.js:137), so a 64-bit digest here is strictly less sensitive than
 * state this DB already holds, and it is not reversible at API-key entropy.
 */
function fingerprintKey(rawApiKey) {
  if (typeof rawApiKey !== "string" || !rawApiKey) return null;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < rawApiKey.length; i++) {
    const c = rawApiKey.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `raw:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function budgetKeyId(apiKeyInfo, rawApiKey) {
  const id = apiKeyInfo?.id;
  if (typeof id === "string" && id) return id;
  return fingerprintKey(rawApiKey) || LOCAL_KEY_ID;
}

/**
 * Resolve the daily per-key cap in cents, or null when the gate is disabled.
 *   settings.spendBudgetCents > 0   → enabled (preferred)
 *   settings.spendBudgetCents 0|false → explicitly disabled, wins over the env
 *   process.env.SPEND_BUDGET_CENTS  → enabled (deployments that cannot edit settings)
 *   nothing                          → disabled
 */
export function resolveBudgetLimitCents(settings) {
  const raw = settings?.spendBudgetCents;
  if (raw === 0 || raw === false) return null;
  const fromSettings = Number(raw);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return Math.floor(fromSettings);
  const fromEnv = Number(process.env.SPEND_BUDGET_CENTS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return null;
}

/**
 * Approximate serialized size of a request-body field, WITHOUT serializing it.
 *
 * This used to be `JSON.stringify(value).length`, which is a full deep walk plus
 * a large throwaway string per field — four of them (`messages`, `input`,
 * `system`, `tools`) on every gated request, immediately before the body is
 * serialized again for the upstream call. An agentic client carrying a 500KB+
 * conversation history paid a complete extra serialize per request just to
 * measure it.
 *
 * Summing string lengths recursively is O(n) with no allocation. It undercounts
 * the structural overhead (braces, commas, quotes, key names) that
 * JSON.stringify would include, so the reserve is marginally smaller than
 * before — the reserve formula is explicitly a worst-case approximation and is
 * floored at MIN_RESERVE_CENTS, so this stays on the safe side of the intent.
 *
 * Cyclic structures cannot occur (bodies come from request.json()), but a caller
 * could still hand one in. The depth cap makes that terminate instead of
 * recursing forever, and hitting it means the value is unmeasurable, so the
 * whole field is charged 0 — the same fail-open branch the old
 * JSON.stringify-throws path produced, and the behaviour
 * tests/unit/spend-budget-gate.test.js pins ("never throws on a cyclic body").
 */
const MEASURE_MAX_DEPTH = 64;
const UNMEASURABLE = Symbol("unmeasurable");

function measureLength(value, depth = 0) {
  if (value === undefined || value === null) return 0;
  if (depth > MEASURE_MAX_DEPTH) return UNMEASURABLE;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (typeof value === "bigint") return String(value).length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      const n = measureLength(item, depth + 1);
      if (n === UNMEASURABLE) return UNMEASURABLE;
      total += n;
    }
    return total;
  }
  if (typeof value === "object") {
    let total = 0;
    for (const [key, item] of Object.entries(value)) {
      const n = measureLength(item, depth + 1);
      if (n === UNMEASURABLE) return UNMEASURABLE;
      total += key.length + n;
    }
    return total;
  }
  // function / symbol: JSON.stringify drops these, so contribute nothing.
  return 0;
}

function safeJsonLength(value) {
  try {
    const n = measureLength(value);
    return n === UNMEASURABLE ? 0 : n;
  } catch {
    // A getter that throws, or a Proxy trap that throws. Charge 0 for the field
    // rather than failing the whole request.
    return 0;
  }
}

export function estimatePromptChars(body, modality) {
  const fields = PROMPT_FIELDS[modality] || PROMPT_FIELDS.llm;
  let chars = 0;
  for (const field of fields) chars += safeJsonLength(body?.[field]);
  return chars;
}

function resolveOutputReserveTokens(body, modality) {
  if (!TOKEN_BILLED_MODALITIES.has(modality)) return 0;
  const explicit = [body?.max_tokens, body?.max_completion_tokens, body?.max_output_tokens]
    .map(Number)
    .find((v) => Number.isFinite(v) && v > 0);
  if (explicit === undefined) return DEFAULT_OUTPUT_RESERVE_TOKENS;
  return Math.min(MAX_OUTPUT_RESERVE_TOKENS, Math.max(MIN_OUTPUT_RESERVE_TOKENS, Math.floor(explicit)));
}

function resolveRates(provider, model) {
  const pricing = getPricingForModel(provider, model);
  if (pricing && Number.isFinite(pricing.input) && Number.isFinite(pricing.output)) {
    return { input: pricing.input, output: pricing.output, priced: true };
  }
  return { ...FALLBACK_PRICING, priced: false };
}

/**
 * Split a `provider/model` string into the pair the pricing table is keyed by.
 * Mirrors the core rule in open-sse/services/model.js:39-45 (`includes("/")`, split
 * on the FIRST slash). Resolving the alias to a canonical provider id is skipped on
 * purpose: it is only used for the single PROVIDER_PRICING override (`gh`), and
 * pulling in the registry module would make the gate depend on a 145-module graph.
 */
export function resolveModelRef({ provider, model, modelStr } = {}) {
  const s = typeof modelStr === "string" ? modelStr : "";
  const slash = s.indexOf("/");
  const split = slash > 0
    ? { provider: s.slice(0, slash), model: s.slice(slash + 1) }
    : { provider: null, model: s || null };
  return { provider: provider || split.provider, model: model || split.model };
}

/**
 * Worst-case cents to pre-authorize for one request. Pure — no DB, no clock.
 *
 * `multiplier` scales the reserve for a single client request that fans out into
 * several billable upstream calls — a fusion combo dispatches N panel models plus
 * one judge, so its worst case is N+1 requests, not one. Settlement is unchanged
 * (it still charges exactly one reservation), so over-reserving here only ever
 * biases the cap toward the safe side.
 */
export function estimateReserveCents({ modality = "llm", body, provider, model, modelStr, multiplier = 1 } = {}) {
  const ref = resolveModelRef({ provider, model, modelStr });
  const promptTokens = Math.ceil(estimatePromptChars(body, modality) / CHARS_PER_TOKEN);
  const outputTokens = resolveOutputReserveTokens(body, modality);
  const rates = resolveRates(ref.provider, ref.model);
  const fanOut = Number.isFinite(Number(multiplier)) && Number(multiplier) >= 1 ? Math.floor(Number(multiplier)) : 1;
  const cents = ((promptTokens * rates.input + outputTokens * rates.output) / 1e6) * 100 * fanOut;
  return { cents: Math.max(MIN_RESERVE_CENTS, Math.ceil(cents)), rates, promptTokens, outputTokens, fanOut };
}

function readState(db, key) {
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [BUDGET_SCOPE, key]);
  return normalizeState(row ? parseJson(row.value, null) : null);
}

function normalizeState(raw) {
  const s = Number(raw?.s);
  const pending = {};
  for (const [id, entry] of Object.entries(raw?.p && typeof raw.p === "object" ? raw.p : {})) {
    const c = Number(entry?.c);
    const t = Number(entry?.t);
    if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(t)) continue;
    pending[id] = { c, t };
  }
  return { s: Number.isFinite(s) && s > 0 ? Math.floor(s) : 0, p: pending };
}

function writeState(db, key, state) {
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [BUDGET_SCOPE, key, stringifyJson(state)]
  );
}

function committedCents(state) {
  let total = state.s;
  for (const entry of Object.values(state.p)) total += entry.c;
  return total;
}

/**
 * Reclaim reservations that were never settled. Stale entries are COMMITTED, not
 * released: the upstream may well have been dispatched and billed, and giving that
 * money back would defeat the cap. Committing is bounded and idempotent, so the
 * reservation can never block the key indefinitely.
 */
function sweepStalePending(state, now, ttlMs) {
  let swept = 0;
  for (const [id, entry] of Object.entries(state.p)) {
    if (now - entry.t < ttlMs) continue;
    state.s += entry.c;
    swept++;
    delete state.p[id];
  }
  return swept;
}

function makeDecision(allowed, payload) {
  const decision = { allowed, enabled: true, status: HTTP_STATUS.PAYMENT_REQUIRED, reservationId: null, ...payload };
  decision.dispatch = async (run) => {
    try {
      const response = await run();
      await settleSpend(decision, response);
      return response;
    } catch (err) {
      await settleSpend(decision, null);
      throw err;
    }
  };
  // For a refusal that happens AFTER the reservation was taken but BEFORE any
  // upstream dispatch (today: the combo ACL check). Nothing was sent upstream, so
  // nothing may be charged — without this the client could burn a key's whole
  // daily budget by repeatedly requesting combos it is not allowed to use, at zero
  // upstream cost. Passing null means "no upstream spend", which settles the
  // entry as released. Never throws; an unreleasable entry is still bounded by
  // the stale-reservation sweep.
  decision.release = async () => {
    try {
      await settleSpend(decision, null);
    } catch (e) {
      log.warn("BUDGET", `Failed to release reservation ${decision.reservationId}: ${e?.message}`);
    }
  };
  // Raise an existing reservation in place to cover a handler that fans one client
  // request out into several billable upstream calls (a fusion combo: N panel
  // models + 1 judge). Adjusting the SAME pending entry inside one transaction
  // keeps a single reservation id, so `settleSpend` needs no second code path and
  // no window exists in which the key holds no reservation at all.
  //
  // Fails CLOSED: if the escalated worst case does not fit in what is left of the
  // daily cap, the caller must not dispatch. A silently-degraded reserve here is
  // exactly the bug this exists to remove.
  decision.escalate = async (fanOut = 1) => {
    const n = Math.floor(Number(fanOut));
    if (!decision.enabled || !decision.reservationId || !Number.isFinite(n) || n <= 1) {
      return { ok: true, decision };
    }
    const targetCents = Math.ceil(decision.reserveCents * n);
    const delta = targetCents - decision.reserveCents;
    if (delta <= 0) return { ok: true, decision };

    let outcome;
    try {
      const db = await getAdapter();
      outcome = db.transaction(() => {
        const state = readState(db, decision.key);
        const entry = state.p[decision.reservationId];
        // Already settled or swept — nothing to raise, and re-adding it would
        // resurrect a reservation the caller may already have given back.
        if (!entry) return { ok: true, committed: committedCents(state) };
        const projected = committedCents(state) + delta;
        if (projected > decision.limitCents) {
          return { ok: false, committed: committedCents(state) - entry.c };
        }
        entry.c = targetCents;
        writeState(db, decision.key, state);
        return { ok: true, committed: committedCents(state) };
      });
    } catch (e) {
      log.warn("BUDGET", `Failed to escalate reservation ${decision.reservationId} to ${n}x: ${e?.message}`);
      return {
        ok: false,
        status: HTTP_STATUS.PAYMENT_REQUIRED,
        message: "Spend budget unavailable: the budget counter could not be updated. Retry later.",
      };
    }

    if (!outcome.ok) {
      // Nothing was billed and nothing will be dispatched: hand the reservation
      // back so a refused fusion request costs the key nothing.
      await decision.release();
      return {
        ok: false,
        status: HTTP_STATUS.PAYMENT_REQUIRED,
        message: `Daily spend budget exhausted (${outcome.committed}c of ${decision.limitCents}c used; this fusion request needs ${targetCents}c). Resets at 00:00 UTC.`,
      };
    }

    decision.reserveCents = targetCents;
    log.debug("BUDGET", `Escalated reservation ${decision.reservationId} to ${n}x = ${targetCents}c of ${decision.limitCents}c`);
    return { ok: true, decision };
  };
  return decision;
}

/**
 * Check the budget and, if there is room, pre-authorize this request's worst case.
 * Never throws.
 *
 * `multiplier` is for a single client request whose handler fans out into several
 * billable upstream calls (a fusion combo: N panel models + 1 judge). Defaults to 1.
 *
 * @returns decision with `.allowed`, and on refusal `.status`/`.message` for the
 *          handler's own errorResponse(). On success `.dispatch(fn)` runs the
 *          upstream work and settles the reservation from the resulting response.
 */
export async function reserveSpend({ settings, apiKeyInfo, apiKey, modality = "llm", body, provider, model, modelStr, multiplier = 1 } = {}) {
  const limitCents = resolveBudgetLimitCents(settings);
  if (limitCents === null) {
    // Disabled: no DB access, no behaviour change.
    const noopDispatch = (run) => run();
    // `escalate` is a no-op here but MUST exist: the fusion path calls it
    // unconditionally, and a missing method would be a TypeError on every
    // fusion request in a deployment that never enabled the gate.
    const noopEscalate = async () => ({ ok: true, decision: null });
    return {
      allowed: true, enabled: false, status: null, message: null, reservationId: null,
      dispatch: noopDispatch,
      escalate: noopEscalate,
      release: async () => {},
    };
  }

  const { cents: reserveCents, rates, fanOut } = estimateReserveCents({ modality, body, provider, model, modelStr, multiplier });
  const key = `${budgetDateKey()}:${budgetKeyId(apiKeyInfo, apiKey)}`;
  const ttlMs = pendingTtlMs();
  const reservationId = newReservationId();

  let outcome;
  try {
    const db = await getAdapter();
    const now = Date.now();
    // Read-modify-write inside one synchronous transaction callback. No `await`
    // inside it, so two concurrent requests can never interleave and both see the
    // same pre-write value — this is what makes the budget a real gate under load.
    outcome = db.transaction(() => {
      const state = readState(db, key);
      const swept = sweepStalePending(state, now, ttlMs);
      const committed = committedCents(state);
      if (committed + reserveCents > limitCents) {
        return { allowed: false, committed, swept };
      }
      state.p[reservationId] = { c: reserveCents, t: now };
      writeState(db, key, state);
      return { allowed: true, committed: committed + reserveCents, swept };
    });
  } catch (e) {
    log.warn("BUDGET", `Spend budget counter unavailable — refusing request: ${e?.message}`);
    return makeDecision(false, {
      status: HTTP_STATUS.PAYMENT_REQUIRED,
      message: "Spend budget unavailable: the budget counter could not be read. Retry later.",
      limitCents,
      reserveCents,
    });
  }

  if (outcome.swept) {
    log.info("BUDGET", `Reclaimed ${outcome.swept} unsettled reservation(s) for ${key}`);
  }

  if (!outcome.allowed) {
    log.warn("BUDGET", `Daily budget exhausted for ${key}: ${outcome.committed}c committed + ${reserveCents}c reserve > ${limitCents}c limit`);
    return makeDecision(false, {
      message: `Daily spend budget exhausted (${outcome.committed}c of ${limitCents}c used; this request needs ${reserveCents}c). Resets at 00:00 UTC.`,
      limitCents,
      reserveCents,
      spentCents: outcome.committed,
    });
  }

  log.debug("BUDGET", `Reserved ${reserveCents}c of ${limitCents}c for ${key} (priced=${rates.priced}${fanOut > 1 ? `, fanOut=${fanOut}` : ""})`);
  return makeDecision(true, { reservationId, key, limitCents, reserveCents, spentCents: outcome.committed });
}

/**
 * Settle a pre-authorization against the response the upstream work produced.
 * Never throws — a throw here must not replace the client's real response.
 *
 * charged = response?.ok === true. A 402/429/5xx from the provider means the target
 * was not billed, so the reservation is released; a thrown dispatch releases it too
 * (settled with a null response). Anything else would be guesswork about a bill we
 * cannot see, so it is charged in full.
 */
export async function settleSpend(decision, response) {
  const id = decision?.reservationId;
  if (!id || !decision?.key) return;
  const charged = response?.ok === true;
  try {
    const db = await getAdapter();
    db.transaction(() => {
      const state = readState(db, decision.key);
      const entry = state.p[id];
      // Missing entry: already settled, or already swept and committed. Charging
      // again here would double-count, so this is a no-op.
      if (!entry) return;
      delete state.p[id];
      if (charged) state.s += entry.c;
      writeState(db, decision.key, state);
    });
    log.debug("BUDGET", `Settled reservation ${id} for ${decision.key}: ${charged ? `charged ${decision.reserveCents}c` : "released (no upstream spend)"}`);
  } catch (e) {
    // The pending entry stays put. The next reserveSpend() for this key sweeps it
    // after PENDING_TTL_MS and commits it exactly once, so this cannot strand.
    log.warn("BUDGET", `Failed to settle reservation ${id} for ${decision.key}; it will be reclaimed by the stale-reservation sweep: ${e?.message}`);
  }
}
