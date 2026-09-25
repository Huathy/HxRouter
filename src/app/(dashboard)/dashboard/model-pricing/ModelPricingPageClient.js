"use client";

import { useEffect, useMemo, useState } from "react";
import { CardSkeleton } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

const CATALOG_URL = "/api/pricing/catalog";

// Provider badge colors, keyed by HxRouter provider id.
const PROVIDER_STYLES = {
  anthropic: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  openai: "bg-green-500/15 text-green-600 dark:text-green-400",
  google: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  deepseek: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  kimi: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  "kimi-cn": "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  glm: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "glm-cn": "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  qwen: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "qwen-cn": "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  minimax: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "minimax-cn": "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  xai: "bg-neutral-500/15 text-neutral-600 dark:text-neutral-300",
};

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  "kimi-cn": "Kimi CN",
  glm: "GLM",
  "glm-cn": "GLM CN",
  qwen: "Qwen",
  "qwen-cn": "Qwen CN",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  xai: "xAI",
};

function formatPrice(v) {
  if (v === null || v === undefined) return "—";
  return `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
}

function SyncTime({ at, now }) {
  if (!at) return <>Never</>;
  const diffMin = Math.floor(((Number.isFinite(now) ? now : at) - at) / 60000);
  return (
    <>
      {diffMin < 1 ? (
        <>just now</>
      ) : diffMin < 60 ? (
        <><span>{diffMin}</span> <span>minutes ago</span></>
      ) : diffMin < 1440 ? (
        <><span>{Math.floor(diffMin / 60)}</span> <span>hours ago</span></>
      ) : (
        <><span>{Math.floor(diffMin / 1440)}</span> <span>days ago</span></>
      )}
      {" · "}
      <span>{new Date(at).toLocaleString()}</span>
    </>
  );
}

export default function ModelPricingPageClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ models: [], lastSync: null, now: null });
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(CATALOG_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!controller.signal.aborted) setData(json);
      } catch (e) {
        if (!controller.signal.aborted) setError(e.message || "Failed to load pricing");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const providers = useMemo(
    () => [...new Set(data.models.map((m) => m.provider))].sort(),
    [data.models]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.models.filter((m) => {
      if (providerFilter !== "all" && m.provider !== providerFilter) return false;
      if (!q) return true;
      return m.model.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q);
    });
  }, [data.models, query, providerFilter]);

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 px-1 py-16 sm:px-0">
        <span className="material-symbols-outlined text-[40px] text-text-muted">error</span>
        <p className="text-sm text-text-muted">Failed to load pricing: {error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
      {/* Header: sync status */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text-main">Model Pricing</h1>
          <p className="text-xs text-text-muted">
            <span>{data.models.length}</span> <span>models</span> · <span>source</span>: models.dev · <span>last sync</span>:{" "}
            <span className={data.lastSync ? "text-green-600 dark:text-green-400" : "text-text-muted"}>
              <SyncTime at={data.lastSync?.at} now={data.now} />
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Provider filter */}
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="h-8 rounded-lg border border-border-subtle bg-surface-1 px-2 text-xs text-text-main outline-none focus:border-primary/50"
          >
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p] || p}</option>
            ))}
          </select>
          {/* Search */}
          <div className="relative">
            <span className="material-symbols-outlined pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[16px] text-text-muted">
              search
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search model…"
              className="h-8 w-44 rounded-lg border border-border-subtle bg-surface-1 pl-7 pr-2 text-xs text-text-main outline-none placeholder:text-text-muted/60 focus:border-primary/50"
            />
          </div>
        </div>
      </div>

      {/* Pricing table */}
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
        <div className="max-h-[calc(100vh-220px)] overflow-y-auto custom-scrollbar">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur">
              <tr className="text-[11px] uppercase tracking-wider text-text-muted">
                <th className="px-4 py-2.5 font-semibold">Provider</th>
                <th className="px-4 py-2.5 font-semibold">Model</th>
                <th className="px-4 py-2.5 font-semibold text-right">Input</th>
                <th className="px-4 py-2.5 font-semibold text-right">Output</th>
                <th className="px-4 py-2.5 font-semibold text-right">Cached</th>
                <th className="px-4 py-2.5 font-semibold text-right">Cache Write</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-text-muted">
                    No models match “{query}”
                  </td>
                </tr>
              ) : (
                filtered.map((m) => (
                  <tr key={`${m.provider}/${m.model}`} className="border-t border-border-subtle/60 hover:bg-surface-2/60 transition-colors">
                    <td className="px-4 py-2">
                      <span className={cn("inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold", PROVIDER_STYLES[m.provider] || "bg-surface-2 text-text-muted")}>
                        {PROVIDER_LABELS[m.provider] || m.provider}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-text-main">{m.model}</td>
                    <td className="px-4 py-2 text-right font-mono text-[11px]">{formatPrice(m.input)}</td>
                    <td className="px-4 py-2 text-right font-mono text-[11px]">{formatPrice(m.output)}</td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] text-text-muted">{formatPrice(m.cached)}</td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] text-text-muted">{formatPrice(m.cacheCreation)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px] text-text-muted/70 px-1">
        Prices in USD per 1M tokens. Synced automatically every 6 hours from lab-direct rates on models.dev.
      </p>
    </div>
  );
}
