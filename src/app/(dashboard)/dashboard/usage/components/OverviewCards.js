"use client";

import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

function fmtSpeed(n) {
  if (n == null) return "—";
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}b t/s`;
  if (n >= 1e4) return `${Math.round(n / 1e4)}w t/s`;
  return `${n.toFixed(1)} t/s`;
}

function fmtToken(n) {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}B`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}W`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export default function OverviewCards({ stats }) {
  const totalReq = stats.totalRequests || 0;
  const totalSuccess = stats.totalSuccess || 0;
  const totalFail = stats.totalFail || 0;
  const successRate = totalReq > 0 ? (totalSuccess / totalReq * 100) : null;
  const rateColor = successRate == null ? "text-text-muted" : successRate >= 95 ? "text-success" : successRate >= 80 ? "text-warning" : "text-error";
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Success Rate</span>
        <span className={`truncate text-2xl font-bold ${rateColor}`}>{successRate == null ? "—" : `${successRate.toFixed(1)}%`}</span>
        <span className="text-[10px] text-text-muted">
          {totalReq > 0 ? `${fmt(totalSuccess)} ok / ${fmt(totalFail)} fail` : "no data"}
        </span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Speed</span>
        <span className="truncate text-2xl font-bold text-text-main">
          {stats.avgLatencyMs != null ? `${(stats.avgLatencyMs / 1000).toFixed(1)}s` : "—"}
        </span>
        <span className="text-[10px] text-text-muted">
          {stats.avgTokensPerSecond != null ? fmtSpeed(stats.avgTokensPerSecond) : "—"}
        </span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Input Tokens</span>
        <span className="truncate text-2xl font-bold text-primary">{fmtToken(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Cached Tokens</span>
        <span className="truncate text-2xl font-bold text-info">{fmtToken(stats.totalCachedTokens)}</span>
        <span className="text-[10px] text-text-muted">
          {stats.totalPromptTokens > 0 ? `${((stats.totalCachedTokens / stats.totalPromptTokens) * 100).toFixed(1)}% hit rate` : "0.0% hit rate"}
        </span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Output Tokens</span>
        <span className="truncate text-2xl font-bold text-success">{fmtToken(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Est. Cost</span>
        <span className="truncate text-2xl font-bold text-warning">~{fmtCost(stats.totalCost)}</span>
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
      </Card>
    </div>
  );
}


