"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getPricingForModel } from "open-sse/providers/pricing.js";

const RADIAN = Math.PI * 2;
const MAX_ACTIVE_DOTS = 80;
const MAX_COMPLETED_DOTS = 50;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getModelLabel(key) {
  const match = key.match(/^(.*) \((.*)\)$/);
  if (match) return { model: match[1], provider: match[2] };
  return { model: key, provider: "" };
}

// ponytail: log-scale price → radius. completed base [0.5,1.0], active = 2x capped 2.0 (dia 4px).
// Upgrade to a tunable scale if visual granularity needs finer control.
function priceRadius(provider, model, isActive) {
  const p = getPricingForModel(provider, model);
  const sum = p ? (p.input + p.output) : 1;
  const lo = Math.log10(0.3);
  const hi = Math.log10(80);
  const f = Math.max(0, Math.min(1, (Math.log10(sum) - lo) / (hi - lo)));
  const base = 0.5 + f * 0.5;
  return isActive ? Math.min(4, base * 4) : base;
}

export default function ModelPieChart({ byModel, activeRequests = [], last10Minutes = [] }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animRef = useRef(null);
  const dotsRef = useRef({ active: [], completed: [] });
  const [dims, setDims] = useState({ width: 0, height: 0, dpr: 1 });

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
          tokensPerSecond: data.tokensPerSecond || 0,
          avgLatencyMs: data.avgLatencyMs || null,
        };
      })
      .sort((a, b) => b.requests - a.requests);
  }, [byModel]);

  const totalRequests = useMemo(() => chartData.reduce((sum, d) => sum + d.requests, 0), [chartData]);

  const totalActive = useMemo(() => activeRequests.reduce((sum, r) => sum + (r.count || 0), 0), [activeRequests]);

  const speedMap = useMemo(() => {
    const map = {};
    for (const entry of chartData) {
      if (entry.tokensPerSecond > 0) {
        map[entry.value] = Math.max(0.3, Math.min(1.5, entry.tokensPerSecond / 20));
      } else if (entry.avgLatencyMs && entry.avgLatencyMs > 0) {
        map[entry.value] = Math.max(0.3, Math.min(1.5, 500 / entry.avgLatencyMs));
      } else {
        map[entry.value] = 0.5;
      }
    }
    return map;
  }, [chartData]);

  useEffect(() => {
    // active count per model key, for subtracting from completed
    const activeByKey = {};
    for (const req of activeRequests) {
      const k = `${req.model} (${req.provider})`;
      activeByKey[k] = (activeByKey[k] || 0) + (req.count || 0);
    }

    const active = [];
    let placedActive = 0;
    for (const req of activeRequests) {
      const key = `${req.model} (${req.provider})`;
      const speed = speedMap[key] || 0.5;
      const color = getProviderConfig(req.provider).color || "#6366f1";
      const r = priceRadius(req.provider, req.model, true);
      const count = Math.min(req.count || 1, MAX_ACTIVE_DOTS - placedActive);
      placedActive += count;
      for (let i = 0; i < count; i++) {
        active.push({
          angle: Math.random() * RADIAN,
          speed,
          r,
          color,
        });
      }
      if (placedActive >= MAX_ACTIVE_DOTS) break;
    }

    const completed = [];
    let placedCompleted = 0;
    for (const entry of chartData) {
      if (placedCompleted >= MAX_COMPLETED_DOTS) break;
      const done = Math.max(0, entry.requests - (activeByKey[entry.value] || 0));
      const count = Math.min(done, MAX_COMPLETED_DOTS - placedCompleted);
      for (let i = 0; i < count; i++) {
        completed.push({
          angle: Math.random() * RADIAN,
          distFactor: Math.random(),
          r: 1,
          phase: Math.random() * RADIAN,
          twinkleSpeed: 0.002 + Math.random() * 0.004,
        });
      }
      placedCompleted += count;
    }

    dotsRef.current = { active, completed };
  }, [activeRequests, speedMap, chartData]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims({ width, height, dpr });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.width === 0) return;
    const ctx = canvas.getContext("2d");
    const { width, height, dpr } = dims;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.min(cx, cy);
    const outerR = maxR * 0.3;
    const innerR = outerR * 0.75;
    const activeOrbitR = outerR + 10;
    const scatterMin = outerR + 6;
    const scatterMax = Math.min(maxR * 0.92, maxR - 4);

    let last = performance.now();

    const draw = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      ctx.clearRect(0, 0, width, height);

      if (chartData.length > 0 && totalRequests > 0) {
        let start = -Math.PI / 2;
        chartData.forEach((entry) => {
          const slice = (entry.requests / totalRequests) * RADIAN;
          ctx.beginPath();
          ctx.moveTo(cx + innerR * Math.cos(start), cy + innerR * Math.sin(start));
          ctx.arc(cx, cy, outerR, start, start + slice);
          ctx.arc(cx, cy, innerR, start + slice, start, true);
          ctx.closePath();
          ctx.fillStyle = entry.color;
          ctx.fill();
          start += slice;
        });
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, (outerR + innerR) / 2, 0, RADIAN);
        ctx.strokeStyle = "rgba(107,114,128,0.15)";
        ctx.lineWidth = outerR - innerR;
        ctx.stroke();
      }

      const mainFontSize = Math.max(9, outerR * 0.26);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = `600 ${mainFontSize}px ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(totalRequests.toLocaleString(), cx, cy - 4);

      ctx.fillStyle = "#9ca3af";
      ctx.font = `400 ${mainFontSize * 0.68}px ui-sans-serif, system-ui`;
      ctx.fillText("requests", cx, cy + mainFontSize * 0.7);

      if (totalActive > 0) {
        ctx.fillStyle = "#818cf8";
        ctx.font = `500 ${mainFontSize * 0.6}px ui-sans-serif, system-ui`;
        ctx.fillText(`● ${totalActive} active`, cx, cy + mainFontSize * 1.35);
      }

      const { completed } = dotsRef.current;
      completed.forEach((dot) => {
        const twinkle = 0.5 + 0.5 * Math.sin(now * dot.twinkleSpeed + dot.phase);
        ctx.globalAlpha = 0.35 + 0.45 * twinkle;
        ctx.fillStyle = "rgba(107, 114, 128, 1)";
        const dist = scatterMin + dot.distFactor * (scatterMax - scatterMin);
        const x = cx + dist * Math.cos(dot.angle);
        const y = cy + dist * Math.sin(dot.angle);
        ctx.beginPath();
        ctx.arc(x, y, dot.r, 0, RADIAN);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      ctx.shadowBlur = 8;
      const { active } = dotsRef.current;
      active.forEach((dot) => {
        dot.angle += dot.speed * dt;
        if (dot.angle > RADIAN) dot.angle -= RADIAN;

        const x = cx + activeOrbitR * Math.cos(dot.angle);
        const y = cy + activeOrbitR * Math.sin(dot.angle);

        ctx.shadowColor = dot.color;
        ctx.beginPath();
        ctx.arc(x, y, dot.r, 0, RADIAN);
        ctx.fillStyle = dot.color;
        ctx.fill();
      });
      ctx.shadowBlur = 0;

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [dims, chartData, totalRequests, totalActive]);

  if (chartData.length === 0 && totalActive === 0) {
    return (
      <div className="h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px] flex items-center justify-center text-text-muted text-sm">
        No usage
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {chartData.length > 0 && (
        <div className="absolute bottom-2 left-0 right-0 flex flex-wrap justify-center gap-x-4 gap-y-1 px-2">
          {chartData.slice(0, 7).map((entry) => (
            <div key={entry.value} className="flex items-center gap-1.5 text-[10px] text-text-muted">
              <span className="inline-block h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
              <span className="truncate max-w-[70px]">{entry.name}</span>
              <span className="font-mono tabular-nums">
                {totalRequests > 0 ? ((entry.requests / totalRequests) * 100).toFixed(0) : 0}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
