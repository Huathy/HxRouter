"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { FREE_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";

// Keep providers without serviceKinds (default LLM) or with "llm" in serviceKinds
function isLLMProvider(id) {
  const p = AI_PROVIDERS[id];
  if (!p?.serviceKinds) return true;
  return p.serviceKinds.includes("llm");
}
import Badge from "./Badge";
import Card from "./Card";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";
import UsageTable, { fmt, fmtTime } from "@/app/(dashboard)/dashboard/usage/components/UsageTable";
import ModelPieChart from "@/app/(dashboard)/dashboard/usage/components/ModelPieChart";
import UsageChart from "@/app/(dashboard)/dashboard/usage/components/UsageChart";

// Skeleton placeholders sized to match the final content so the layout does
// not shift (CLS) when data arrives. Keep dimensions in sync with the real
// components they replace.
const overviewSkeleton = (
  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 sm:gap-4">
    {Array.from({ length: 4 }).map((_, i) => (
      <div key={i} className="h-24 w-full animate-pulse rounded-lg border border-border bg-bg-subtle/50" aria-hidden="true" />
    ))}
  </div>
);

const topologySkeleton = (
  <div className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2">
    <div className="h-[320px] w-full animate-pulse rounded-lg border border-border bg-bg-subtle/50 sm:h-[480px]" aria-hidden="true" />
    <div className="h-[320px] w-full animate-pulse rounded-lg border border-border bg-bg-subtle/50 sm:h-[480px]" aria-hidden="true" />
  </div>
);

const chartSkeleton = (
  <div className="h-[220px] w-full animate-pulse rounded-lg border border-border bg-bg-subtle/50" aria-hidden="true" />
);

const tableSkeleton = (
  <div className="h-64 w-full animate-pulse rounded-lg border border-border bg-bg-subtle/50" aria-hidden="true" />
);

function timeAgo(timestamp) {
  const diff = Math.floor((Date.now() - new Date(timestamp)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Auto-update time display every second without re-rendering parent
function TimeAgo({ timestamp }) {
  const [, setTick] = useState(0);
  
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  
  return <>{timeAgo(timestamp)}</>;
}

const EMPTY_REQUESTS = [];

// Defensive merge for SSE pushes: a lightweight push can legitimately carry
// fewer completed rows than are already displayed (e.g. a slower DB read or a
// dedup boundary). Never let history "shrink" on a partial payload — union the
// completed rows, always trust the fresh pending rows, newest first, cap 20.
function mergeRecentRequests(prevRequests, incoming) {
  const prevList = Array.isArray(prevRequests) ? prevRequests : [];
  if (!Array.isArray(incoming)) return prevList;

  const pending = incoming.filter((r) => r.inFlight === true);
  const incomingCompleted = incoming.filter((r) => r.inFlight !== true);
  const prevCompleted = prevList.filter((r) => r.inFlight !== true);
  if (incomingCompleted.length >= prevCompleted.length) return incoming;

  const rowKey = (r) => `${r.timestamp}|${r.model}|${r.provider || ""}|${r.httpStatus ?? ""}|${r.promptTokens}|${r.completionTokens}`;
  const merged = new Map();
  for (const r of [...prevCompleted, ...incomingCompleted]) {
    if (!merged.has(rowKey(r))) merged.set(rowKey(r), r);
  }
  const completed = [...merged.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return [...pending, ...completed].slice(0, 20);
}

function RecentRequests({ requests = EMPTY_REQUESTS, providerNodeNames = {} }) {
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden" padding="sm" style={{ height: 480 }}>
      {/* Header */}
      <div className="px-1 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Recent Requests</span>
      </div>

      {!requests.length ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No requests yet.</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full min-w-[420px] border-collapse text-xs">
            <thead className="sticky top-0 bg-bg z-10">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-semibold text-text-muted w-2"><span className="sr-only">Status</span></th>
                <th className="py-1.5 pl-1 text-left font-semibold text-text-muted">Model</th>
                <th className="py-1.5 pl-1 text-left font-semibold text-text-muted">Provider</th>
                <th className="py-1.5 pl-1 text-left font-semibold text-text-muted">Account</th>
                <th className="py-1.5 text-right font-semibold text-text-muted whitespace-nowrap">In / Out</th>
                <th className="py-1.5 text-right font-semibold text-text-muted">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {requests.map((r, i) => {
                const ok = !r.status || r.status === "ok" || r.status === "success";
                const inFlight = r.inFlight === true;
                return (
                  <tr key={`${r.timestamp}-${r.model}-${i}-${inFlight ? "p" : "c"}`} className={`hover:bg-bg-subtle transition-colors ${inFlight ? "bg-primary/5" : ""}`}>
                    <td className="py-1.5">
                      {inFlight ? (
                        <span className="material-symbols-outlined animate-spin text-[14px] text-primary">progress_activity</span>
                      ) : (
                        (() => {
                          const code = r.httpStatus;
                          const c = Number(code);
                          const dotCls = !ok ? "bg-error" : (c >= 400 && c < 500 ? "bg-yellow-500" : "bg-success");
                          const txt = code != null ? String(code) : (ok ? "200" : "ERR");
                          return (
                            <span className="inline-flex items-center gap-1">
                              <span className={`block w-1.5 h-1.5 rounded-full ${dotCls}`} aria-label={ok ? "Success" : "Error"} />
                              <span className="font-mono text-[10px] text-text-muted">{txt}</span>
                            </span>
                          );
                        })()
                      )}
                    </td>
                    <td className="pl-1 py-1.5 font-mono truncate max-w-[120px]" title={r.model}>
                      <span className="truncate">{r.model}</span>
                      {inFlight && <span className="ml-1 rounded bg-primary/10 px-1 text-[10px] text-primary">pending</span>}
                    </td>
                    <td className="pl-1 py-1.5 whitespace-nowrap max-w-[120px]">
                      {r.provider ? (
                        <Badge variant={inFlight ? "primary" : "neutral"} size="sm" className="max-w-full truncate">{providerNodeNames[r.provider] || r.provider}</Badge>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="pl-1 py-1.5 max-w-[110px] truncate text-text-muted" title={r.account || ""}>
                      {r.account || "—"}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      {inFlight ? (
                        <span className="text-text-muted">—</span>
                      ) : (
                        <>
                          <span className="text-primary">{fmt(r.promptTokens)}↑</span>
                          {" "}
                          <span className="text-success">{fmt(r.completionTokens)}↓</span>
                        </>
                      )}
                    </td>
                    <td className="py-1.5 text-right text-text-muted whitespace-nowrap">
                      {inFlight ? "now" : <TimeAgo timestamp={r.timestamp} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function sortData(dataMap, pendingMap = {}, sortBy, sortOrder) {
  return Object.entries(dataMap || {})
    .map(([key, data]) => {
      const totalTokens = (data.promptTokens || 0) + (data.completionTokens || 0);
      const totalCost = data.cost || 0;
      // ponytail: cost split is a token-share allocation of the (rate-accurate)
      // server total, not a per-rate recompute. cached is a subset of prompt, so
      // peel it out of the input share. Upgrade to a stored per-component cost
      // breakdown if exact cached-rate cost display is needed.
      const cachedTokens = data.cachedTokens || 0;
      const nonCachedInput = Math.max(0, (data.promptTokens || 0) - cachedTokens);
      const inputCost = totalTokens > 0 ? nonCachedInput * (totalCost / totalTokens) : 0;
      const cachedCost = totalTokens > 0 ? cachedTokens * (totalCost / totalTokens) : 0;
      const outputCost = totalTokens > 0 ? (data.completionTokens || 0) * (totalCost / totalTokens) : 0;
      const successCount = data.successCount || 0;
      const failCount = data.failCount || 0;
      const successRate = (data.requests || 0) > 0 ? successCount / (data.requests || 0) : null;
      return { ...data, key, totalTokens, totalCost, inputCost, cachedCost, outputCost, successCount, failCount, successRate, pending: pendingMap[key] || 0, avgLatencyMs: (data.latencyCount > 0 ? data.latencyMs / data.latencyCount : null), tokensPerSecond: (data.latencyMs > 0 && data.latencyCount > 0 && totalTokens > 0 ? totalTokens / data.latencyMs * 1000 : null) };
    })
    .sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (typeof valA === "string") valA = valA.toLowerCase();
      if (typeof valB === "string") valB = valB.toLowerCase();
      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });
}

function getGroupKey(item, keyField) {
  switch (keyField) {
    case "rawModel": return item.rawModel || "Unknown Model";
    case "accountName": return item.accountName || `Account ${item.connectionId?.slice(0, 8)}...` || "Unknown Account";
    case "keyName": return item.keyName || "Unknown Key";
    case "endpoint": return item.endpoint || "Unknown Endpoint";
    default: return item[keyField] || "Unknown";
  }
}

function groupDataByKey(data, keyField) {
  if (!Array.isArray(data)) return [];
  const groups = {};
  data.forEach((item) => {
    const gk = getGroupKey(item, keyField);
    if (!groups[gk]) {
      groups[gk] = {
        groupKey: gk,
        summary: {
          requests: 0, successCount: 0, failCount: 0,
          promptTokens: 0, completionTokens: 0, cachedTokens: 0,
          totalTokens: 0, cost: 0, inputCost: 0, cachedCost: 0, outputCost: 0,
          latencyMs: 0, latencyCount: 0, avgLatencyMs: null, tokensPerSecond: null,
          lastUsed: null, pending: 0,
          provider: null, rawModel: null, keyName: null, endpoint: null
        },
        items: [],
      };
    }
    const s = groups[gk].summary;
    s.requests += item.requests || 0;
    s.successCount += item.successCount || 0;
    s.failCount += item.failCount || 0;
    s.promptTokens += item.promptTokens || 0;
    s.completionTokens += item.completionTokens || 0;
    s.cachedTokens += item.cachedTokens || 0;
    s.totalTokens += item.totalTokens || 0;
    s.cost += item.cost || 0;
    s.inputCost += item.inputCost || 0;
    s.cachedCost += item.cachedCost || 0;
    s.outputCost += item.outputCost || 0;
    s.latencyMs += item.latencyMs || 0;
    s.latencyCount += item.latencyCount || 0;
    s.pending += item.pending || 0;
    if (item.lastUsed && (!s.lastUsed || new Date(item.lastUsed) > new Date(s.lastUsed))) {
      s.lastUsed = item.lastUsed;
    }

    const trackUnique = (field) => {
      if (s[field] === null) {
        s[field] = item[field] || undefined;
      } else if (s[field] !== undefined && s[field] !== item[field]) {
        s[field] = undefined;
      }
    };
    trackUnique("provider");
    trackUnique("rawModel");
    trackUnique("keyName");
    trackUnique("endpoint");

    groups[gk].items.push(item);
  });
  // Finalize derived summary fields (successRate) after accumulation.
  for (const g of Object.values(groups)) {
    g.summary.successRate = g.summary.requests > 0 ? g.summary.successCount / g.summary.requests : null;
    g.summary.avgLatencyMs = g.summary.latencyCount > 0 ? g.summary.latencyMs / g.summary.latencyCount : null;
    g.summary.tokensPerSecond = (g.summary.latencyMs > 0 && g.summary.latencyCount > 0 && g.summary.totalTokens > 0)
      ? g.summary.totalTokens / g.summary.latencyMs * 1000
      : null;
  }
  return Object.values(groups);
}

const MODEL_COLUMNS = [
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "successRate", label: "Success Rate", align: "right" },
  { field: "tokensPerSecond", label: "Speed", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ACCOUNT_COLUMNS = [
  { field: "accountName", label: "Account" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "successRate", label: "Success Rate", align: "right" },
  { field: "tokensPerSecond", label: "Speed", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const API_KEY_COLUMNS = [
  { field: "keyName", label: "API Key Name" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "successRate", label: "Success Rate", align: "right" },
  { field: "tokensPerSecond", label: "Speed", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ENDPOINT_COLUMNS = [
  { field: "endpoint", label: "Endpoint" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "successRate", label: "Success Rate", align: "right" },
  { field: "tokensPerSecond", label: "Speed", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const TABLE_OPTIONS = [
  { value: "model", label: "Usage by Model" },
  { value: "account", label: "Usage by Account" },
  { value: "apiKey", label: "Usage by API Key" },
  { value: "endpoint", label: "Usage by Endpoint" },
];

// Render a success-rate cell. rate is 0..1 or null (no data). Historical day
// rows without success/fail counts show "—" since the rate is unknown, not 0%.
function SuccessRateBadge({ rate }) {
  if (rate == null) return <span className="text-text-muted">—</span>;
  const pct = rate * 100;
  const variant = rate >= 0.95 ? "success" : rate >= 0.8 ? "warning" : "error";
  return <Badge variant={variant} size="sm">{pct.toFixed(0)}%</Badge>;
}

// Render latency + throughput. Both null (no latency samples) → "—".
function SpeedCell({ latencyMs, tokensPerSecond }) {
  if (latencyMs == null) return <span className="text-text-muted">—</span>;
  return (
    <span className="whitespace-nowrap font-mono text-xs">
      {latencyMs.toFixed(1)}ms{tokensPerSecond != null ? ` / ${tokensPerSecond.toFixed(1)} t/s` : ""}
    </span>
  );
}

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

function PeriodSelector({ period, setPeriod, fetching }) {
  return (
        <div className="flex w-full items-center gap-2 sm:w-auto sm:self-end">
          <div className="grid flex-1 grid-cols-5 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex sm:flex-none">
            {PERIODS.map((p) => (
              <button type="button"
                key={p.value}
                onClick={() => setPeriod(p.value)}
                disabled={fetching}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${period === p.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {fetching && (
            <span className="material-symbols-outlined text-[16px] text-text-muted animate-spin">progress_activity</span>
          )}
        </div>
  );
}


export default function UsageStats({ period: periodProp, setPeriod: setPeriodProp, hidePeriodSelector = false } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortBy = searchParams.get("sortBy") || "rawModel";
  const sortOrder = searchParams.get("sortOrder") || "asc";
  const [stats, setStats] = useState(null);
  const [loadState, setLoadState] = useState({ loading: true, fetching: false });
  const loading = loadState.loading;
  const fetching = loadState.fetching;
  const [tableView, setTableView] = useState("model");
  const [viewMode, setViewMode] = useState("costs");
  const [providers, setProviders] = useState([]);
  const [providerNodeNames, setProviderNodeNames] = useState({});
  const [periodLocal, setPeriodLocal] = useState("today");
  const isInitialLoad = useRef(true);
  const hasLoadedStats = useRef(false);
  const period = periodProp ?? periodLocal;
  const setPeriod = setPeriodProp ?? setPeriodLocal;
  // Fetch connected providers once, deduplicate by provider type
  // Always include noAuth free providers (e.g. opencode) regardless of connections
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/providers", { signal: controller.signal }).then((r) => r.ok ? r.json() : null),
      fetch("/api/provider-nodes", { signal: controller.signal }).then((r) => r.ok ? r.json() : null),
    ])
      .then(([d, nodesData]) => {
        if (controller.signal.aborted) return;
        // Build node name lookup for custom providers
        const nodeNameMap = {};
        for (const node of (nodesData?.nodes || [])) {
          nodeNameMap[node.id] = node.name;
        }
        setProviderNodeNames(nodeNameMap);
        const seen = new Set();
        const unique = (d?.connections || []).reduce((acc, c) => {
          if (c.isActive === false || !isLLMProvider(c.provider) || seen.has(c.provider)) return acc;
          seen.add(c.provider);
          acc.push({ ...c, nodeName: nodeNameMap[c.provider] || null });
          return acc;
        }, []);
        const noAuthProviders = Object.values(FREE_PROVIDERS).reduce((acc, p) => {
          if (p.noAuth && !seen.has(p.id) && isLLMProvider(p.id)) acc.push({ provider: p.id, name: p.name });
          return acc;
        }, []);
        setProviders([...unique, ...noAuthProviders]);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  // Fetch filtered stats via REST when period changes
  useEffect(() => {
    // First load: show full spinner; subsequent: show subtle fetching indicator
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      setLoadState({ loading: true, fetching: false });
    } else {
      setLoadState({ loading: false, fetching: true });
    }

    const controller = new AbortController();
    fetch(`/api/usage/stats?period=${period}`, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data) {
          hasLoadedStats.current = true;
          setStats((prev) => ({ ...prev, ...data }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoadState({ loading: false, fetching: false });
      });
    return () => controller.abort();
  }, [period]);
  // SSE connection - real-time updates for activeRequests + recentRequests only
  useEffect(() => {
    const es = new EventSource("/api/usage/stream");

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Always merge only real-time fields, never overwrite full stats from REST
        setStats((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeRequests: data.activeRequests,
            recentRequests: mergeRecentRequests(prev.recentRequests, data.recentRequests),
            errorProvider: data.errorProvider,
            pending: data.pending,
          };
        });
        if (hasLoadedStats.current) setLoadState(prev => ({ ...prev, loading: false }));
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };

    es.onerror = () => setLoadState(prev => ({ ...prev, loading: false }));

    return () => es.close();
  }, []);

  const toggleSort = useCallback((tableType, field) => {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get("sortBy") === field) {
      params.set("sortOrder", params.get("sortOrder") === "asc" ? "desc" : "asc");
    } else {
      params.set("sortBy", field);
      params.set("sortOrder", "asc");
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  // Compute active table data
  const activeTableConfig = useMemo(() => {
    if (!stats) return null;
    switch (tableView) {
      case "model": {
        const pendingMap = stats.pending?.byModel || {};
        return {
          columns: MODEL_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byModel, pendingMap, sortBy, sortOrder), "rawModel"),
          storageKey: "usage-stats:expanded-models",
          emptyMessage: "No usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3">
                {group.summary.provider ? (
                  <Badge variant={group.summary.pending > 0 ? "primary" : "neutral"} size="sm">{group.summary.provider}</Badge>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={group.summary.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={group.summary.avgLatencyMs} tokensPerSecond={group.summary.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={"px-6 py-3 font-medium transition-colors" + (item.pending > 0 ? " text-primary" : "")}>{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={item.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={item.avgLatencyMs} tokensPerSecond={item.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "account": {
        const pendingMap = {};
        if (stats?.pending?.byAccount) {
          Object.entries(stats.byAccount || {}).forEach(([accountKey, data]) => {
            const connPending = stats.pending.byAccount[data.connectionId];
            if (connPending) {
              const modelKey = data.provider ? `${data.rawModel} (${data.provider})` : data.rawModel;
              pendingMap[accountKey] = connPending[modelKey] || 0;
            }
          });
        }
        return {
          columns: ACCOUNT_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byAccount, pendingMap, sortBy, sortOrder), "accountName"),
          storageKey: "usage-stats:expanded-accounts",
          emptyMessage: "No account-specific usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3">
                {group.summary.rawModel ? (
                  <span className="font-medium text-text-main">{group.summary.rawModel}</span>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
              <td className="px-6 py-3">
                {group.summary.provider ? (
                  <Badge variant={group.summary.pending > 0 ? "primary" : "neutral"} size="sm">{group.summary.provider}</Badge>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={group.summary.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={group.summary.avgLatencyMs} tokensPerSecond={group.summary.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={"px-6 py-3 font-medium transition-colors" + (item.pending > 0 ? " text-primary" : "")}>{item.accountName || `Account ${item.connectionId?.slice(0, 8)}...`}</td>
              <td className={"px-6 py-3 font-medium transition-colors" + (item.pending > 0 ? " text-primary" : "")}>{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant={item.pending > 0 ? "primary" : "neutral"} size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={item.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={item.avgLatencyMs} tokensPerSecond={item.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "apiKey": {
        return {
          columns: API_KEY_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byApiKey, {}, sortBy, sortOrder), "keyName"),
          storageKey: "usage-stats:expanded-apikeys",
          emptyMessage: "No API key usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3">
                {group.summary.rawModel ? (
                  <span className="font-medium text-text-main">{group.summary.rawModel}</span>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
              <td className="px-6 py-3">
                {group.summary.provider ? (
                  <Badge variant="neutral" size="sm">{group.summary.provider}</Badge>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={group.summary.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={group.summary.avgLatencyMs} tokensPerSecond={group.summary.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium">{item.keyName}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant="neutral" size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={item.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={item.avgLatencyMs} tokensPerSecond={item.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "endpoint":
      default: {
        return {
          columns: ENDPOINT_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byEndpoint, {}, sortBy, sortOrder), "endpoint"),
          storageKey: "usage-stats:expanded-endpoints",
          emptyMessage: "No endpoint usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3">
                {group.summary.rawModel ? (
                  <span className="font-medium text-text-main">{group.summary.rawModel}</span>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
              <td className="px-6 py-3">
                {group.summary.provider ? (
                  <Badge variant="neutral" size="sm">{group.summary.provider}</Badge>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={group.summary.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={group.summary.avgLatencyMs} tokensPerSecond={group.summary.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium font-mono text-sm">{item.endpoint}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><Badge variant="neutral" size="sm">{item.provider}</Badge></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right"><SuccessRateBadge rate={item.successRate} /></td>
              <td className="px-6 py-3 text-right"><SpeedCell latencyMs={item.avgLatencyMs} tokensPerSecond={item.tokensPerSecond} /></td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
    }
  }, [stats, tableView, sortBy, sortOrder]);

  if (!stats && !loading) return <div className="text-text-muted">Failed to load usage statistics.</div>;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Period selector (hidden when controlled by parent) */}
      {!hidePeriodSelector && <PeriodSelector period={period} setPeriod={setPeriod} fetching={fetching} />}

      {/* Overview cards */}
      {loading ? overviewSkeleton : <OverviewCards stats={stats} />}

      {/* Model pie chart + Recent Requests */}
      {loading ? topologySkeleton : (
        <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 lg:grid-cols-2">
          <ModelPieChart
            byModel={stats.byModel || {}}
            activeRequests={stats.activeRequests || []}
            last10Minutes={stats.last10Minutes || []}
          />
          <RecentRequests requests={stats.recentRequests || []} providerNodeNames={providerNodeNames} />
        </div>
      )}

      {/* Token / Cost chart - sync period */}
      {loading ? chartSkeleton : <UsageChart period={period} />}

      {/* Table with dropdown selector */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <select
            value={tableView}
            onChange={(e) => setTableView(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 sm:w-auto"
            style={{ colorScheme: 'auto' }}
          >
            {TABLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex">
            <button type="button"
              onClick={() => setViewMode("costs")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "costs" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Costs
            </button>
            <button type="button"
              onClick={() => setViewMode("tokens")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Tokens
            </button>
          </div>
        </div>
        {loading ? tableSkeleton : activeTableConfig && (
          <UsageTable
            title=""
            columns={activeTableConfig.columns}
            groupedData={activeTableConfig.groupedData}
            tableType={tableView}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onToggleSort={toggleSort}
            viewMode={viewMode}
            storageKey={activeTableConfig.storageKey}
            renderSummaryCells={activeTableConfig.renderSummaryCells}
            renderDetailCells={activeTableConfig.renderDetailCells}
            emptyMessage={activeTableConfig.emptyMessage}
          />
        )}
      </div>
    </div>
  );
}
