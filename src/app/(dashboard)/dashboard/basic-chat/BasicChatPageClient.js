"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { marked } from "marked";
import { Badge, Button } from "@/shared/components";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getProviderAlias, isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";
import { usageFromChunk, formatUsageSummary } from "@/shared/utils/sseUsage.js";

marked.setOptions({ gfm: true, breaks: true });

// Same sanitizer + policy as ChangelogModal.js: marked output is untrusted
// model text, so it never reaches the DOM without DOMPurify.
function sanitizeHtml(html) {
  if (typeof window === "undefined") return "";
  const DOMPurify = require("dompurify");
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["script", "iframe", "object", "embed", "form"], FORBID_ATTR: ["onerror", "onload", "onclick"] });
}

// Markdown is applied to the ASSISTANT message only. It costs a ~40KB gzip of
// `marked` + `dompurify` in the client bundle and an HTML parse per render, so
// the user's own input — which is plain text typed into the textarea — is
// rendered as text, never as markdown.
function renderMarkdown(md) {
  if (!md) return "";
  return sanitizeHtml(marked.parse(md));
}

// Assistant bubble body. A component (not an inline block in the message map)
// so `marked.parse` can be memoized per content string.
//
// The memo is only effective if its key changes at a BOUNDED rate, not once per
// streamed chunk: during a stream `content` is the whole accumulated answer, so
// memoizing on it would re-parse and re-sanitize the entire reply for every
// chunk — quadratic over a long answer. The caller therefore feeds this
// component a throttled value (see useThrottledValue below); a finished message
// passes its final text straight through and renders immediately.
function AssistantMarkdown({ content, showCursor = false }) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <>
      <div
        className="break-words text-[15px] leading-7 [&_a]:text-blue-300 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_blockquote]:text-white/60 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_hr]:my-3 [&_hr]:border-white/10 [&_img]:max-w-full [&_img]:rounded-lg [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_table]:block [&_table]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5"
        // SECURITY: html is sanitized via DOMPurify.sanitize() before reaching this element
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {showCursor ? <span className="inline-block animate-pulse">▋</span> : null}
    </>
  );
}

// ~8fps. Fast enough that the bubble still visibly fills as the reply streams,
// slow enough that marked.parse + DOMPurify.sanitize run a bounded number of
// times instead of once per chunk.
const MARKDOWN_REFRESH_MS = 120;

/**
 * Rate-limit a rapidly-changing value to at most one update per `delayMs`.
 *
 * Used for the streaming assistant text, whose consumer (AssistantMarkdown) does
 * O(len) work per render: re-rendering it on every chunk makes a streamed reply
 * quadratic. The raw text still advances on every chunk — only what the markdown
 * layer sees is throttled, so typing/cursor feedback is unaffected.
 *
 * A pending timer always commits the LATEST value (not the one captured when it
 * was scheduled), so a burst of chunks can never leave stale text on screen.
 */
function useThrottledValue(value, delayMs = MARKDOWN_REFRESH_MS) {
  const [throttled, setThrottled] = useState(value);
  const latestRef = useRef(value);
  const lastCommitRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    latestRef.current = value;
    if (timerRef.current !== null) return; // an update is already scheduled
    const wait = delayMs - (Date.now() - lastCommitRef.current);
    if (wait <= 0) {
      lastCommitRef.current = Date.now();
      setThrottled(value);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastCommitRef.current = Date.now();
      setThrottled(latestRef.current);
    }, wait);
  }, [value, delayMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return throttled;
}

const STORAGE_KEYS = {
  sessions: "basic-chat.sessions",
  activeSessionId: "basic-chat.activeSessionId",
  activeProviderId: "basic-chat.activeProviderId",
  activeModelId: "basic-chat.activeModelId",
  draft: "basic-chat.draft",
};

const MODELS_CACHE_KEY = "basic-chat.modelsCache.v2";
// The local cache is never treated as stale-by-age: it seeds the first paint and
// is replaced by background refreshes driven by the change stream, a periodic
// timer, and window focus.
const MODELS_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MODELS_CHANGE_DEBOUNCE_MS = 400;
const MAX_VISIBLE_MODELS = 8;

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function ensureSessionForModel(model) {
  if (!model) return null;
  return {
    id: createId(),
    title: "New chat",
    providerId: model.providerId,
    providerName: model.providerName,
    modelId: model.id,
    modelName: model.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.flatMap(v => { const t = textValue(v); return t ? [t] : []; }).join(" ");
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function humanize(value = "") {
  return String(value)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || "Unknown";
}

function formatRelativeTime(value) {
  if (!value) return "Now";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Now";
  const diffMinutes = Math.max(1, Math.round((Date.now() - time) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.round(diffHours / 24)}d`;
}

function makeSessionTitle(text = "") {
  const normalized = textValue(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 52 ? `${normalized.slice(0, 52).trimEnd()}…` : normalized;
}

function buildUserContent(message) {
  const text = textValue(message.content).trim();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (attachments.length === 0) return text;

  const content = [];
  if (text) content.push({ type: "text", text });

  for (const attachment of attachments) {
    if (attachment?.dataUrl) {
      content.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    }
  }

  return content.length > 0 ? content : text;
}

function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function cloneSession(session) {
  return {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages.map((message) => ({ ...message })) : [],
  };
}

function getProviderLabel(connection) {
  // 兼容协议节点：优先 node 级名称（如"商汤"），其次账号名 fallback
  if (connection?.nodeName) return connection.nodeName;
  return connection?.name || humanize(connection?.provider || connection?.id || "provider");
}

function normalizeStaticModel(model, connection, alias) {
  if (!model?.id) return null;
  const requestModel = `${alias}/${model.id}`;
  return {
    id: requestModel,
    requestModel,
    name: model.name || model.id,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "static",
  };
}

function normalizeCustomModel(model, connection, alias) {
  if (!model?.id) return null;
  const requestModel = `${alias}/${model.id}`;
  return {
    id: requestModel,
    requestModel,
    name: model.name || model.id,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "custom",
  };
}

function normalizeLiveModel(model, connection) {
  const rawId = typeof model === "string" ? model : model?.id || model?.name || model?.model || "";
  if (!rawId) return null;

  const displayName = typeof model === "string"
    ? model
    : model?.name || model?.displayName || rawId;

  let requestModel = rawId;
  const isCompatible = isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider);
  if (isCompatible && !rawId.includes("/")) {
    requestModel = `${connection.provider}/${rawId}`;
  }

  return {
    id: requestModel,
    requestModel,
    name: displayName,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "live",
  };
}

function parseProviderModelsPayload(data) {
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function dedupeModels(models) {
  const map = new Map();
  for (const model of models) {
    if (!model?.id) continue;
    if (!map.has(model.id)) map.set(model.id, model);
  }
  return Array.from(map.values());
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatch(text, query) {
  const q = query.trim();
  if (!q) return text;
  const re = new RegExp(`(${escapeRegex(q)})`, "ig");
  const parts = String(text).split(re);
  const qLower = q.toLowerCase();
  return parts.map((part, index) =>
    part.toLowerCase() === qLower
      ? <mark key={index} className="rounded bg-yellow-400/30 px-0.5 text-yellow-100">{part}</mark>
      : <span key={index}>{part}</span>
  );
}

function resolveGroupKey(connection) {
  const rawProvider = connection.provider || connection.id;
  // 兼容协议节点：按 connection 自身分组，避免所有同类节点合并成一个"Anthropic/OpenAI Compatible"分组
  if (isOpenAICompatibleProvider(rawProvider) || isAnthropicCompatibleProvider(rawProvider)) {
    const label = getProviderLabel(connection);
    return { key: rawProvider, name: label, rawProvider };
  }
  return { key: rawProvider, name: null, rawProvider };
}

// Compatible protocol nodes and Cursor only expose a usable catalog upstream, so
// they must be resolved live. Every other provider has a curated catalog that is
// what the provider detail page calls "Available Models".
function isLiveFirstProvider(rawProvider) {
  return isOpenAICompatibleProvider(rawProvider)
    || isAnthropicCompatibleProvider(rawProvider)
    || rawProvider === "cursor";
}

function isLlmModel(model) {
  const kind = getModelKind(model);
  return !kind || kind === "llm";
}

async function fetchLiveConnectionModels(connection, { refresh = false, signal } = {}) {
  try {
    const url = refresh
      ? `/api/providers/${connection.id}/models?refresh=1`
      : `/api/providers/${connection.id}/models`;
    const response = await fetch(url, { cache: "no-store", signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return [];
    return parseProviderModelsPayload(data)
      .flatMap((model) => { const m = normalizeLiveModel(model, connection); return m ? [m] : []; });
  } catch {
    return [];
  }
}

async function fetchAndBuildGroups({ refresh = false, signal } = {}) {
  const [providersRes, combosRes, customRes, disabledRes, aliasRes] = await Promise.all([
    fetch("/api/providers", { cache: "no-store", signal }),
    fetch("/api/combos", { cache: "no-store", signal }),
    fetch("/api/models/custom", { cache: "no-store", signal }).catch(() => null),
    fetch("/api/models/disabled", { cache: "no-store", signal }).catch(() => null),
    fetch("/api/models/alias", { cache: "no-store", signal }).catch(() => null),
  ]);
  const providersData = await providersRes.json().catch(() => ({}));
  const combosData = await combosRes.json().catch(() => ({}));
  const customData = customRes ? await customRes.json().catch(() => ({})) : {};
  const disabledData = disabledRes ? await disabledRes.json().catch(() => ({})) : {};
  const aliasData = aliasRes ? await aliasRes.json().catch(() => ({})) : {};

  const connections = Array.isArray(providersData.connections)
    ? providersData.connections.filter((connection) => connection?.isActive === true)
    : [];
  const combos = Array.isArray(combosData.combos)
    ? combosData.combos.filter((combo) => !combo.kind || combo.kind === "llm")
    : [];
  const customModels = Array.isArray(customData.models) ? customData.models : [];
  const disabledByAlias = disabledData.disabled && typeof disabledData.disabled === "object" ? disabledData.disabled : {};
  const modelAliases = aliasData.aliases && typeof aliasData.aliases === "object" ? aliasData.aliases : {};

  if (connections.length === 0 && combos.length === 0) {
    return { groups: [], noProviders: true };
  }

  const providersMap = new Map(
    (Array.isArray(providersData.providers) ? providersData.providers : []).map((provider) => [provider.id, provider])
  );

  // Kilo Code surfaces extra free models on top of its static catalog; the provider
  // detail page merges them into "Available Models", so mirror that here too.
  let kiloFreeModels = [];
  if (connections.some((connection) => (connection.provider || connection.id) === "kilocode")) {
    try {
      const url = refresh
        ? "/api/providers/kilo/free-models?refresh=1"
        : "/api/providers/kilo/free-models";
      const response = await fetch(url, { cache: "no-store", signal });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(data.models)) kiloFreeModels = data.models;
    } catch {
      // Keep the static catalog when the free-model lookup fails.
    }
  }

  const providerMap = new Map();

  const ensureGroup = (connection) => {
    const { key, name, rawProvider } = resolveGroupKey(connection);
    if (!providerMap.has(key)) {
      providerMap.set(key, {
        providerId: key,
        providerName: name || providersMap.get(rawProvider)?.displayName || getProviderLabel(connection),
        providerType: key,
        connections: [],
        models: [],
      });
    }
    const group = providerMap.get(key);
    group.connections.push(connection);
    return group;
  };

  const liveFirstConnections = connections.filter((connection) =>
    isLiveFirstProvider(connection.provider || connection.id)
  );
  const liveCache = new Map(
    await Promise.all(liveFirstConnections.map(async (connection) => [
      connection.id,
      await fetchLiveConnectionModels(connection, { refresh, signal }),
    ]))
  );

  for (const connection of connections) {
    const group = ensureGroup(connection);
    const { rawProvider } = resolveGroupKey(connection);

    if (isLiveFirstProvider(rawProvider)) {
      const liveModels = liveCache.get(connection.id) || [];
      if (liveModels.length > 0) {
        group.models.push(...liveModels);
        continue;
      }
    }

    const alias = getProviderAlias(rawProvider);
    const disabled = new Set([
      ...(Array.isArray(disabledByAlias[alias]) ? disabledByAlias[alias] : []),
      ...(Array.isArray(disabledByAlias[rawProvider]) ? disabledByAlias[rawProvider] : []),
    ]);

    const models = isLiveFirstProvider(rawProvider)
      ? []
      : getModelsByProviderId(rawProvider)
          .filter(isLlmModel)
          .flatMap((model) => { const m = normalizeStaticModel(model, connection, alias); return m ? [m] : []; });

    if (rawProvider === "kilocode") {
      models.push(...kiloFreeModels
        .filter((model) => isLlmModel(model) && model?.id)
        .flatMap((model) => { const m = normalizeCustomModel(model, connection, alias); return m ? [m] : []; }));
    }

    models.push(...customModels
      .filter((model) => isLlmModel(model) && (model.providerAlias === alias || model.providerAlias === rawProvider))
      .flatMap((model) => { const m = normalizeCustomModel(model, connection, alias); return m ? [m] : []; }));

    models.push(...Object.entries(modelAliases).flatMap(([aliasName, fullModel]) => {
      if (typeof fullModel !== "string") return [];
      if (!fullModel.startsWith(`${alias}/`) && !fullModel.startsWith(`${rawProvider}/`)) return [];
      return [{
        id: fullModel,
        requestModel: fullModel,
        name: aliasName,
        providerId: connection.provider,
        providerName: getProviderLabel(connection),
        source: "alias",
      }];
    }));

    const visibleModels = dedupeModels(models).filter((model) => {
      const bareId = model.requestModel.includes("/")
        ? model.requestModel.slice(model.requestModel.indexOf("/") + 1)
        : model.requestModel;
      return !disabled.has(bareId) && !disabled.has(model.id);
    });

    if (visibleModels.length > 0) {
      group.models.push(...visibleModels);
      continue;
    }

    // Nothing curated or registered for this provider: fall back to the live catalog.
    const fallbackModels = liveCache.has(connection.id)
      ? liveCache.get(connection.id)
      : await fetchLiveConnectionModels(connection, { refresh, signal });
    group.models.push(...fallbackModels);
  }

  const comboModels = combos
    .filter((combo) => Array.isArray(combo.models) && combo.models.length > 0)
    .map((combo) => ({
      id: `combo/${combo.name}`,
      requestModel: `combo/${combo.name}`,
      name: combo.name,
      providerId: "combo",
      providerName: "Combos",
      source: "combo",
    }));

  const normalized = Array.from(providerMap.values())
    .reduce((acc, group) => {
      const models = dedupeModels(group.models).sort((a, b) => a.name.localeCompare(b.name));
      if (models.length > 0) acc.push({ ...group, models });
      return acc;
    }, [])
    .sort((a, b) => a.providerName.localeCompare(b.providerName));

  if (comboModels.length > 0) {
    normalized.unshift({
      providerId: "combo",
      providerName: "Combos",
      providerType: "combo",
      connections: [],
      models: dedupeModels(comboModels).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  return { groups: normalized, noProviders: false };
}

function readLocalGroups() {
  if (typeof window === "undefined") return null;
  try {
    const cached = safeParse(globalThis.localStorage.getItem(MODELS_CACHE_KEY), null);
    if (cached && Array.isArray(cached.groups)) {
      return cached.groups;
    }
  } catch {
    // Ignore storage errors.
  }
  return null;
}

function writeLocalGroups(groups) {
  if (typeof window === "undefined") return;
  try {
    globalThis.localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), groups }));
  } catch {
    // Ignore storage errors.
  }
}

function buildGroupsSignature(groups) {
  // Include the model ids, not just counts: editing a provider can swap models
  // without changing how many there are, and that must still refresh the UI.
  return (Array.isArray(groups) ? groups : [])
    .map((group) => `${group.providerId}:[${(group.models || []).map((model) => model.id).join(",")}]`)
    .join("|");
}

export default function BasicChatPageClient() {
  const [providerGroups, setProviderGroups] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sessions, setSessions] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = safeParse(globalThis.localStorage.getItem(STORAGE_KEYS.sessions), []);
      return Array.isArray(saved) ? saved.map((session) => ({
        ...session,
        messages: Array.isArray(session.messages) ? session.messages : [],
      })) : [];
    } catch { return []; }
  });
  const [activeSessionId, setActiveSessionId] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.activeSessionId) || "";
  });
  const [activeProviderId, setActiveProviderId] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.activeProviderId) || "";
  });
  const [activeModelId, setActiveModelId] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.activeModelId) || "";
  });
  const [draft, setDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    return globalThis.localStorage.getItem(STORAGE_KEYS.draft) || "";
  });
  const [attachments, setAttachments] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isHydrated] = useState(() => typeof window !== "undefined");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const initializedRef = useRef(false);
  const groupsSignatureRef = useRef("");
  const modelMenuRef = useRef(null);
  const historyMenuRef = useRef(null);
  const mountedRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const changeDebounceRef = useRef(null);

  // Bounded-rate view of the streaming text for the markdown layer. Falls back to
  // "" the moment streaming stops, so a finished message renders its own final
  // content immediately (see the map below).
  const throttledStreamingText = useThrottledValue(streamingText, MARKDOWN_REFRESH_MS);

  const refreshGroups = useCallback(async ({ refresh = false, silent = true } = {}) => {
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;

    if (!silent) {
      setLoadingData(true);
      setLoadError("");
    }

    try {
      const { groups, noProviders } = await fetchAndBuildGroups({ refresh });
      // A newer refresh superseded this one, or the page unmounted.
      if (!mountedRef.current || seq !== refreshSeqRef.current) return;

      if (noProviders) {
        groupsSignatureRef.current = "";
        setProviderGroups([]);
        setLoadError("No providers or combos configured yet.");
        return;
      }

      // Only re-render when the visible contents actually changed; write the
      // cache on every successful refresh so it never holds a stale list.
      const signature = buildGroupsSignature(groups);
      if (signature !== groupsSignatureRef.current || !silent) {
        groupsSignatureRef.current = signature;
        setProviderGroups(groups);
      }
      if (groups.length > 0) writeLocalGroups(groups);
      setLoadError(groups.length === 0 ? "Providers connected but no models available." : "");
    } catch (error) {
      if (!mountedRef.current || seq !== refreshSeqRef.current) return;
      // Keep the cached UI on a background failure; only surface the error when
      // the user explicitly asked for a refresh.
      if (!silent) setLoadError(textValue(error?.message) || "Failed to refresh models.");
    } finally {
      if (mountedRef.current && seq === refreshSeqRef.current) setLoadingData(false);
    }
  }, []);

  // Seed from the local cache, then always refresh once from the network.
  useEffect(() => {
    mountedRef.current = true;

    const seedFromCache = () => {
      const localGroups = readLocalGroups();
      const hasCache = Array.isArray(localGroups) && localGroups.length > 0;
      if (hasCache) {
        groupsSignatureRef.current = buildGroupsSignature(localGroups);
        setProviderGroups(localGroups);
        setLoadingData(false);
      } else {
        setLoadingData(true);
      }
      return hasCache;
    };

    const hasCache = seedFromCache();
    refreshGroups({ silent: hasCache });

    return () => {
      mountedRef.current = false;
    };
  }, [refreshGroups]);

  // Refresh immediately when a provider/combo/model edit is broadcast by the
  // server, so the dropdown reflects dashboard edits without a manual reload.
  useEffect(() => {
    if (!isHydrated || typeof EventSource === "undefined") return undefined;

    let source;
    try {
      source = new EventSource("/api/models/events");
    } catch {
      return undefined;
    }

    const scheduleRefresh = () => {
      if (changeDebounceRef.current) clearTimeout(changeDebounceRef.current);
      changeDebounceRef.current = setTimeout(() => {
        changeDebounceRef.current = null;
        refreshGroups({ silent: true });
      }, MODELS_CHANGE_DEBOUNCE_MS);
    };

    source.onmessage = (event) => {
      if (!event?.data) return;
      const payload = safeParse(event.data, null);
      if (payload?.type === "changed") scheduleRefresh();
    };
    // The browser reconnects EventSource automatically, so transient errors and
    // reconnects need no handling here.

    return () => {
      if (changeDebounceRef.current) {
        clearTimeout(changeDebounceRef.current);
        changeDebounceRef.current = null;
      }
      source.close();
    };
  }, [isHydrated, refreshGroups]);

  // Periodic refresh plus a refresh whenever the tab becomes visible again,
  // covering edits made on another device that the change stream can't reach.
  useEffect(() => {
    if (!isHydrated) return undefined;

    const tick = () => {
      if (document.visibilityState === "hidden") return;
      refreshGroups({ silent: true });
    };

    const interval = setInterval(tick, MODELS_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [isHydrated, refreshGroups]);

  const handleRefreshModels = () => refreshGroups({ refresh: true, silent: false });

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target)) {
        setModelMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(event.target)) {
        setHistoryOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const modelIndex = useMemo(() => {
    const map = new Map();
    for (const group of providerGroups) {
      for (const model of group.models) {
        map.set(model.id, {
          ...model,
          providerId: group.providerId,
          providerName: group.providerName,
        });
      }
    }
    return map;
  }, [providerGroups]);

  const filteredProviderGroups = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return providerGroups;
    return providerGroups
      .map((group) => {
        // Match the provider / combo group name too, so searching e.g. "airforce"
        // or a combo's group keeps every model under it visible.
        const groupMatches = group.providerName.toLowerCase().includes(q);
        return {
          ...group,
          groupMatches,
          models: groupMatches
            ? group.models
            : group.models.filter((model) =>
                model.name.toLowerCase().includes(q) ||
                model.requestModel.toLowerCase().includes(q)
              ),
        };
      })
      .filter((group) => group.models.length > 0);
  }, [providerGroups, modelSearch]);

  const activeProviderGroup = useMemo(() => {
    return providerGroups.find((group) => group.providerId === activeProviderId) || providerGroups[0] || null;
  }, [providerGroups, activeProviderId]);

  const activeModel = useMemo(() => {
    if (activeModelId && modelIndex.has(activeModelId)) return modelIndex.get(activeModelId);
    if (activeSessionId) {
      const session = sessions.find((item) => item.id === activeSessionId);
      if (session?.modelId && modelIndex.has(session.modelId)) return modelIndex.get(session.modelId);
    }
    return activeProviderGroup?.models?.[0] || null;
  }, [activeModelId, modelIndex, activeProviderGroup, sessions, activeSessionId]);

  const currentSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) || null, [sessions, activeSessionId]);
  const currentMessages = currentSession?.messages || [];
  const sessionItems = useMemo(() => sessions.toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [sessions]);
  const canSend = !isSending && !!activeModel && (draft.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      globalThis.localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
      globalThis.localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
      globalThis.localStorage.setItem(STORAGE_KEYS.activeProviderId, activeProviderId);
      globalThis.localStorage.setItem(STORAGE_KEYS.activeModelId, activeModelId);
      globalThis.localStorage.setItem(STORAGE_KEYS.draft, draft);
    } catch {
      // Ignore storage errors.
    }
  }, [isHydrated, sessions, activeSessionId, activeProviderId, activeModelId, draft]);

  useEffect(() => {
    if (!isHydrated || loadingData || initializedRef.current) return;
    if (providerGroups.length === 0) return;

    const savedProvider = providerGroups.find((group) => group.providerId === activeProviderId) || providerGroups[0];
    const savedModel = activeModelId && modelIndex.has(activeModelId)
      ? modelIndex.get(activeModelId)
      : savedProvider.models[0];

    if (sessions.length > 0) {
      const session = sessions.find((item) => item.id === activeSessionId) || sessions[0];
      const sessionModel = session?.modelId && modelIndex.has(session.modelId)
        ? modelIndex.get(session.modelId)
        : savedModel;
      initializedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time bootstrap: rehydrates active session on first mount when persisted session exists.
      setActiveSessionId(session.id);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time bootstrap.
      setActiveProviderId(sessionModel?.providerId || savedProvider.providerId);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time bootstrap.
      setActiveModelId(sessionModel?.id || savedModel.id);
      return;
    }

    const session = {
      id: createId(),
      title: "New chat",
      providerId: savedProvider.providerId,
      providerName: savedProvider.providerName,
      modelId: savedModel.id,
      modelName: savedModel.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    initializedRef.current = true;
    setSessions([session]);
    setActiveSessionId(session.id);
    setActiveProviderId(savedProvider.providerId);
    setActiveModelId(savedModel.id);
  }, [isHydrated, loadingData, providerGroups, modelIndex, activeProviderId, activeModelId, sessions, activeSessionId]);

  const updateSession = (sessionId, updater) => {
    setSessions((prev) => prev.map((session) => (session.id === sessionId ? updater(cloneSession(session)) : session)));
  };

  const handleNewChat = () => {
    if (!activeModel) return;
    const session = ensureSessionForModel(activeModel);
    if (!session) return;
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setActiveProviderId(session.providerId);
    setActiveModelId(session.modelId);
    setDraft("");
    setAttachments([]);
    setStreamingMessageId("");
    setStreamingText("");
  };

  const handleSelectSession = (sessionId) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setActiveSessionId(sessionId);
    setActiveProviderId(session.providerId || activeProviderId);
    setActiveModelId(session.modelId || activeModelId);
    setHistoryOpen(false);
  };

  const handleDeleteCurrentChat = () => {
    if (!activeSessionId) return;
    const nextSessions = sessions.filter((session) => session.id !== activeSessionId);
    const fallback = nextSessions[0] || null;
    setSessions(nextSessions);
    if (fallback) {
      setActiveSessionId(fallback.id);
      setActiveProviderId(fallback.providerId);
      setActiveModelId(fallback.modelId);
    } else {
      setActiveSessionId("");
      setActiveProviderId("");
      setActiveModelId("");
    }
  };

  const handleSelectProvider = (providerId) => {
    const group = providerGroups.find((item) => item.providerId === providerId);
    if (!group || group.models.length === 0) return;
    const nextModel = group.models[0];

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current) {
      setSessions((prev) => prev.map((item) => (item.id === current.id ? {
        ...item,
        providerId: group.providerId,
        providerName: group.providerName,
        modelId: nextModel.id,
        modelName: nextModel.name,
      } : item)));
    }

    setActiveProviderId(group.providerId);
    setActiveModelId(nextModel.id);
    setModelMenuOpen(false);
  };

  const handleSelectModel = (modelId) => {
    const model = modelIndex.get(modelId);
    if (!model) return;

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current) {
      setSessions((prev) => prev.map((item) => (item.id === current.id ? {
        ...item,
        providerId: model.providerId,
        providerName: model.providerName,
        modelId: model.id,
        modelName: model.name,
      } : item)));
    } else {
      const session = ensureSessionForModel(model);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    }

    setActiveProviderId(model.providerId);
    setActiveModelId(model.id);
    setModelMenuOpen(false);
  };

  const handleAttachFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      event.target.value = "";
      return;
    }

    const converted = await Promise.all(images.map(async (file) => ({
      id: createId(),
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: await fileToDataUrl(file),
    })));

    setAttachments((prev) => [...prev, ...converted]);
    event.target.value = "";
  };

  const removeAttachment = (attachmentId) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const finalizeSessionTitle = (sessionId, titleSeed) => {
    const title = makeSessionTitle(titleSeed);
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title === "New chat" ? title : session.title,
      updatedAt: new Date().toISOString(),
    }));
  };

  const sendMessage = async () => {
    const model = activeModel || activeProviderGroup?.models?.[0] || null;
    if (!model) return;

    const userText = draft.trim();
    if (!userText && attachments.length === 0) return;

    let sessionId = activeSessionId;
    let session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      session = ensureSessionForModel(model);
      if (!session) return;
      sessionId = session.id;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(sessionId);
    }

    const userMessage = {
      id: createId(),
      role: "user",
      content: userText,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
        dataUrl: attachment.dataUrl,
      })),
      createdAt: new Date().toISOString(),
    };

    const assistantMessageId = createId();
    const assistantMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
    };

    const nextMessages = [...(session.messages || []), userMessage, assistantMessage];
    setSessions((prev) => prev.map((item) => (item.id === sessionId ? {
      ...item,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.id,
      modelName: model.name,
      messages: nextMessages,
      updatedAt: new Date().toISOString(),
      title: item.title === "New chat" ? makeSessionTitle(userText) : item.title,
    } : item)));
    setDraft("");
    setAttachments([]);
    setIsSending(true);
    setStreamingMessageId(assistantMessageId);
    setStreamingText("");
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const requestMessages = nextMessages.reduce((acc, message) => {
      if (!(message.role === "assistant" && message.id === assistantMessageId)) {
        acc.push({ role: message.role, content: message.role === "user" ? buildUserContent(message) : message.content });
      }
      return acc;
    }, []);

    try {
      const response = await fetch("/api/dashboard/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: model.requestModel || model.id,
          messages: requestMessages,
          stream: true,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(textValue(errorData.error || errorData.message || `Request failed (${response.status})`));
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const data = await response.json().catch(() => ({}));
        const fallbackText = textValue(data?.choices?.[0]?.message?.content || data?.output_text || data?.error || data?.message || "");
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: fallbackText, status: "done" } : message)),
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);

            // A usage report arrives as its own frame whose `choices` array is
            // EMPTY (OpenAI `include_usage`) or as `usage` bolted onto the last
            // content frame (every other provider's response translator). It
            // must therefore be read BEFORE the text bail-out below: with an
            // empty `choices`, readAssistantText() returns "" and
            // `if (!text) continue` would drop the only chunk that carries the
            // token counts, leaving the footnote permanently empty.
            //
            // `usageFromChunk(chunk)`, not `extractUsageFromSSE(line)`: this loop
            // has already split, trimmed and parsed `chunk` above, so passing the
            // raw line would re-do all three plus a second JSON.parse of the same
            // payload on every frame of the stream.
            const usage = usageFromChunk(chunk);
            if (usage) {
              updateSession(sessionId, (currentSession) => ({
                ...currentSession,
                messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, usage } : message)),
                updatedAt: new Date().toISOString(),
              }));
            }

            const text = readAssistantText(chunk);
            if (!text) continue;

            assistantText += text;
            setStreamingText(assistantText);
            updateSession(sessionId, (currentSession) => ({
              ...currentSession,
              messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: assistantText, status: "streaming" } : message)),
              updatedAt: new Date().toISOString(),
            }));
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      updateSession(sessionId, (currentSession) => ({
        ...currentSession,
        messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: assistantText || message.content, status: "done" } : message)),
        updatedAt: new Date().toISOString(),
      }));
      finalizeSessionTitle(sessionId, userText);
    } catch (error) {
      if (error.name !== "AbortError") {
        const errorText = textValue(error?.message || error);
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: message.content || `Error: ${errorText}`, status: "error" } : message)),
          updatedAt: new Date().toISOString(),
        }));
        setLoadError(errorText || "Failed to send message.");
      }
    } finally {
      setIsSending(false);
      setStreamingMessageId("");
      setStreamingText("");
      abortRef.current = null;
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) sendMessage();
    }
  };

  const modelLabel = activeModel ? `${activeModel.name}` : "Select model";
  const modelSubLabel = activeModel ? activeModel.requestModel : "Choose from connected providers";

  return (
    <div className="relative flex-1 flex flex-col h-full min-h-0 min-w-0 bg-[#212121] text-white overflow-hidden">
      <div className="relative mx-auto flex flex-1 h-full min-h-0 w-full max-w-4xl flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setModelMenuOpen((value) => !value);
                setModelSearch("");
                setExpandedGroups({});
              }}
              className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:bg-white/8"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{modelLabel}</span>
                  <span className="material-symbols-outlined text-[18px] text-white/70">expand_more</span>
                </div>
                <p className="truncate text-xs text-white/55">{modelSubLabel}</p>
              </div>
            </button>

            {modelMenuOpen ? (
              <div className="absolute left-0 top-[calc(100%+10px)] z-30 w-[min(1000px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-white/10 bg-[#262626] shadow-2xl shadow-black/50">
                <div className="border-b border-white/10 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-white/45">search</span>
                    <input
                      type="text"
                      value={modelSearch}
                      onChange={(event) => {
                        setModelSearch(event.target.value);
                        setExpandedGroups({});
                      }}
                      placeholder="Search models or providers..."
                      autoFocus
                      className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                    />
                    <button
                      type="button"
                      onClick={handleRefreshModels}
                      disabled={loadingData}
                      title="Refresh model list"
                      className="rounded-full p-1 text-white/45 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
                    >
                      <span className={`material-symbols-outlined text-[18px] ${loadingData ? "animate-spin" : ""}`}>refresh</span>
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-white/45">From connected providers & combos</p>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2 custom-scrollbar">
                  {filteredProviderGroups.length === 0 ? (
                    <div className="px-3 py-6 text-center text-sm text-white/45">No models matched &ldquo;{modelSearch}&rdquo;.</div>
                  ) : filteredProviderGroups.map((group) => {
                    const isExpanded = !!expandedGroups[group.providerId];
                    const visibleModels = isExpanded ? group.models : group.models.slice(0, MAX_VISIBLE_MODELS);
                    const hiddenCount = group.models.length - visibleModels.length;
                    return (
                      <div key={group.providerId} className="mb-2 rounded-[16px] border border-white/10 bg-black/20 p-2">
                        <div className="flex items-center justify-between gap-2 px-2 py-2">
                          <p className={`min-w-0 truncate text-sm font-semibold ${group.groupMatches ? "text-blue-200" : "text-white"}`}>
                            {highlightMatch(group.providerName, modelSearch)}
                          </p>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge size="sm" variant="default">{group.models.length}</Badge>
                            {group.models.length > MAX_VISIBLE_MODELS ? (
                              <button
                                type="button"
                                onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.providerId]: !prev[group.providerId] }))}
                                className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70 transition hover:bg-white/8 hover:text-white"
                              >
                                <span className={`material-symbols-outlined text-[16px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
                                {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                          {visibleModels.map((model) => {
                            const isActive = model.id === activeModelId;
                            return (
                              <button
                                key={model.id}
                                type="button"
                                onClick={() => handleSelectModel(model.id)}
                                className={`rounded-[14px] border px-3 py-3 text-left transition ${isActive ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-white">{highlightMatch(model.name, modelSearch)}</p>
                                    <p className="truncate text-[11px] text-white/45">{highlightMatch(model.requestModel, modelSearch)}</p>
                                  </div>
                                  {isActive ? <span className="material-symbols-outlined text-[18px] text-blue-300">check_circle</span> : null}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleNewChat}
              disabled={!activeModel}
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80 transition hover:bg-white/8 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              New chat
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80 transition hover:bg-white/8"
            >
              History
            </button>
            <Button variant="ghost" size="sm" icon="delete" onClick={handleDeleteCurrentChat} disabled={!activeSessionId || sessions.length === 0}>
              Clear
            </Button>
          </div>
        </div>

        {historyOpen ? (
          <div ref={historyMenuRef} className="absolute right-4 top-[72px] z-20 w-[min(360px,calc(100vw-2rem))] rounded-[20px] border border-white/10 bg-[#262626] p-2 shadow-2xl shadow-black/50 lg:right-6">
            <div className="px-3 py-2">
              <p className="text-xs uppercase tracking-[0.22em] text-white/45">Recent chats</p>
            </div>
            <div className="max-h-[48vh] space-y-2 overflow-y-auto p-1 custom-scrollbar">
              {sessionItems.length === 0 ? (
                <div className="rounded-[16px] border border-dashed border-white/10 bg-white/5 p-4 text-sm text-white/55">
                  No conversations yet.
                </div>
              ) : sessionItems.map((session) => {
                const isActive = session.id === activeSessionId;
                const latestMessage = [...(session.messages || [])].reverse().find((message) => message.role === "user") || session.messages?.[0];
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleSelectSession(session.id)}
                    className={`w-full rounded-[16px] border px-3 py-3 text-left transition ${isActive ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{session.title}</p>
                        <p className="mt-1 truncate text-xs text-white/50">{textValue(latestMessage?.content) || "Empty chat"}</p>
                      </div>
                      <span className="text-[10px] text-white/40 shrink-0">{formatRelativeTime(session.updatedAt)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {loadError ? (
          <div className="mt-4 rounded-[18px] border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-rose-100">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-[20px]">error</span>
              <p className="text-sm leading-6">{loadError}</p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 overflow-y-auto py-4 custom-scrollbar">
            {currentMessages.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center px-4 text-center">
                <div className="max-w-xl space-y-4">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-[20px] border border-white/10 bg-white/5 text-white/80">
                    <span className="material-symbols-outlined text-[30px]">chat</span>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-white">Start a conversation</h2>
                    <p className="text-sm leading-6 text-white/60">
                      Simple chat interface to interact with any AI model from connected providers or combos. Select a model and start chatting!
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4">
              {currentMessages.map((message) => {
                const isUser = message.role === "user";
                const isAssistant = message.role === "assistant";
                const isStreaming = isAssistant && message.id === streamingMessageId && message.status === "streaming";
                const content = textValue(message.content) || (isAssistant ? streamingText : "");
                // The streaming bubble renders the throttled text so markdown
                // parse+sanitize runs at most every MARKDOWN_REFRESH_MS instead of
                // once per chunk; every other message renders its own final
                // content immediately.
                const markdownContent = isStreaming ? throttledStreamingText : content;
                const usageFootnote = isAssistant
                  ? formatUsageSummary(message.usage, { provider: activeModel?.providerId, model: activeModel?.id })
                  : "";

                return (
                  <div key={message.id} className={`flex w-full ${isUser ? "justify-end" : "justify-start"} mb-6`}>
                    <div className={`max-w-[min(88%,42rem)] ${isUser ? "rounded-3xl bg-[#2f2f2f] px-5 py-3.5 text-white" : "text-white/90"}`}>
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold">{isUser ? "You" : activeModel?.name || "Assistant"}</span>
                      </div>

                      {message.attachments?.length ? (
                        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 mt-2">
                          {message.attachments.map((attachment) => (
                            <a key={attachment.id} href={attachment.dataUrl} target="_blank" rel="noreferrer" className="overflow-hidden rounded-[18px] border border-white/10 bg-black/20">
                              <Image src={attachment.dataUrl} alt={attachment.name} className="h-28 w-full object-cover" width={0} height={0} sizes="100vw" style={{ width: "100%", height: "112px" }} unoptimized />
                            </a>
                          ))}
                        </div>
                      ) : null}

                      {isAssistant ? (
                        <AssistantMarkdown content={markdownContent} showCursor={isStreaming && !streamingText} />
                      ) : (
                        // User input stays plain text on purpose — see renderMarkdown().
                        <div className="whitespace-pre-wrap break-words text-[15px] leading-7">{content}</div>
                      )}

                      {usageFootnote ? (
                        <p className="mt-2 text-[11px] leading-5 text-white/35">{usageFootnote}</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 pt-2">
            {attachments.length > 0 ? (
              <div className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap gap-2 px-4">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2">
                    <span className="text-xs text-white/80 max-w-[12rem] truncate">{attachment.name}</span>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} className="text-white/55 hover:text-white" aria-label="Remove attachment">
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              <div className="rounded-[26px] bg-[#2f2f2f] px-3 pt-3 pb-2 shadow-[0_0_15px_rgba(0,0,0,0.10)] ring-1 ring-white/5">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message AI"
                  aria-label="Message AI"
                  rows={1}
                  className="w-full resize-none bg-transparent px-2 text-[15px] leading-6 text-white outline-none placeholder:text-white/40 custom-scrollbar max-h-[25vh] overflow-y-auto"
                />

                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!activeModel || loadingData} className="p-2 text-white/50 hover:text-white transition rounded-full hover:bg-white/5">
                      <span className="material-symbols-outlined text-[20px]">attach_file</span>
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleAttachFiles} aria-label="Attach images" />
                    <span className="text-xs font-medium text-white/30 truncate max-w-[120px]">{activeModel ? activeModel.name : "No model"}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {isSending ? (
                      <button type="button" onClick={handleStop} className="p-2 text-white bg-white/10 hover:bg-white/20 transition rounded-full h-8 w-8 flex items-center justify-center">
                        <span className="material-symbols-outlined text-[16px]">stop</span>
                      </button>
                    ) : null}
                    <button type="button" onClick={sendMessage} disabled={!canSend} className={`h-8 w-8 rounded-full flex items-center justify-center transition ${canSend ? 'bg-white text-black hover:opacity-90' : 'bg-white/10 text-white/30 cursor-not-allowed'}`}>
                      <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mx-auto mt-2 max-w-3xl px-4 pb-4 text-center text-[11px] text-white/30">
            Model list is filtered from connected providers.
          </p>
        </div>
      </div>
    </div>
  );
}
