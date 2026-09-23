"use client";

import { useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const RADIAN = Math.PI * 2;
const radiusOuter = 82;
const radiusInner = 52;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getModelLabel(key) {
  const match = key.match(/^(.*) \((.*)\)$/);
  if (match) return { model: match[1], provider: match[2] };
  return { model: key, provider: "" };
}

function sliceLabel({ payload, percent }) {
  if (!payload) return "";
  const { model } = getModelLabel(payload.value);
  if (percent < 0.04) return "";
  return `${model} ${percent != null ? `(${(percent * 100).toFixed(0)}%)` : ""}`;
}

export default function ModelPieChart({ byModel, activeRequests = [], last10Minutes = [] }) {
  const chartData = useMemo(() => {
    const entries = Object.entries(byModel || {});
    if (entries.length === 0) return [];
    return entries
      .map(([key, data]) => {
        const cfg = getModelLabel(key);
        const provCfg = cfg.provider ? getProviderConfig(cfg.provider) : { color: "#6b7280" };
        return {
          value: key,
          name: cfg.model,
          provider: cfg.provider,
          color: provCfg.color || "#6b7280",
          requests: data.requests || 0,
        };
      })
      .sort((a, b) => b.requests - a.requests);
  }, [byModel]);

  const hasActive = activeRequests.length > 0;

  // Derive last rate (req/s) from last10Minutes completed requests
  const lastRate = useMemo(() => {
    if (!last10Minutes || last10Minutes.length === 0) return null;
    const total = (last10Minutes[0]?.requests || 0) + (last10Minutes[1]?.requests || 0);
    const perMin = total / 2;
    return perMin > 0 ? perMin / 60 : null;
  }, [last10Minutes]);

  if (chartData.length === 0) {
    return (
      <div className="h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px] flex items-center justify-center text-text-muted text-sm">
        No usage
      </div>
    );
  }

  return (
    <div className="relative h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px]">
      <div className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip
              contentStyle={{ backgroundColor: "hsl(var(--color-bg))", border: "1px solid hsl(var(--color-border))", borderRadius: "6px" }}
              formatter={(value, name, props) => [props.payload.requests, props.payload.name]}
            />
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              outerRadius={radiusOuter}
              innerRadius={radiusInner}
              paddingAngle={1}
              dataKey="value"
              label={sliceLabel}
              labelLine={false}
              stroke="var(--color-bg-subtle)"
              strokeWidth={2}
            >
              {chartData.map((entry, idx) => (
                <Cell key={`cell-${idx}`} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Outer ring — active request indicator */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          className={
            "rounded-full border-2 border-primary/20 flex items-center justify-center transition-all" +
            (hasActive ? " animate-spin" : "")
          }
          style={{ width: radiusOuter * 2 + 16, height: radiusOuter * 2 + 16 }}
        >
          {hasActive ? (
            <span className="text-[10px] text-primary">Active</span>
          ) : lastRate != null ? (
            <span className="text-[10px] text-text-muted">{lastRate.toFixed(1)} req/s</span>
          ) : (
            <span className="text-[10px] text-text-muted">Idle</span>
          )}
        </div>
      </div>
    </div>
  );
}
