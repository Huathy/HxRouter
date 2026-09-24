"use client";

import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getPricingForModel } from "open-sse/providers/pricing.js";

const RADIAN = Math.PI * 2;
const MAX_ACTIVE_DOTS = 80;
const MAX_COMPLETED_DOTS = 500;

// Running (active) stars get vivid, hash-spread hues so the palette is not
// limited to a fixed 赤橙黄绿青蓝紫 set. High saturation + bright lightness
// keeps them from ever looking gray; only completed/stopped dots use gray.
function vividColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 80 + ((h >> 9) % 16);   // 80-95% — never washed out
  const light = 60 + ((h >> 17) % 10); // 60-69% — a touch brighter than before
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// Radial gap between the edges of stars on neighbouring orbits (px).
const ORBIT_EDGE_GAP = 9;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getModelLabel(key) {
  const match = key.match(/^(.*) \((.*)\)$/);
  if (match) return { model: match[1], provider: match[2] };
  return { model: key, provider: "" };
}

// ponytail: log-scale price → radius. active [6,12] colored+glow, completed [0.5,3.0] gray.
// Upgrade to a tunable scale if visual granularity needs finer control.
function priceRadius(provider, model, isActive) {
  const p = getPricingForModel(provider, model);
  const sum = p ? (p.input + p.output) : 1;
  const lo = Math.log10(0.3);
  const hi = Math.log10(80);
  const f = Math.max(0, Math.min(1, (Math.log10(sum) - lo) / (hi - lo)));
  return isActive ? 6 + f * 6 : 0.5 + f * 2.5;
}

export default function ModelPieChart({ byModel, activeRequests = [], last10Minutes = [] }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animRef = useRef(null);
  const dotsRef = useRef({ active: [], completed: [] });
  const arcsRef = useRef([]);
  const hoverRef = useRef(null);
  const dimsRef = useRef({ cx: 0, cy: 0, innerR: 0, outerR: 0 });
  const [dims, setDims] = useState({ width: 0, height: 0, dpr: 1 });
  const [hover, setHover] = useState(null);

  const chartData = useMemo(() => {
    const entries = Object.entries(byModel || {});
    if (entries.length === 0) return [];
    return entries
      .map(([key, data]) => {
        const cfg = getModelLabel(key);
        const provCfg = cfg.provider ? getProviderConfig(cfg.provider) : { color: "#6b7280" };
        const latencyMs = data.latencyMs || 0;
        const latencyCount = data.latencyCount || 0;
        const totalTokens = (data.promptTokens || 0) + (data.completionTokens || 0);
        return {
          value: key,
          name: cfg.model,
          provider: cfg.provider,
          color: provCfg.color || "#6b7280",
          requests: data.requests || 0,
          successCount: data.successCount || 0,
          failCount: data.failCount || 0,
          avgLatencyMs: latencyCount > 0 ? latencyMs / latencyCount : null,
          tokensPerSecond: (latencyMs > 0 && latencyCount > 0 && totalTokens > 0) ? totalTokens / latencyMs * 1000 : 0,
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
    for (let ri = 0; ri < activeRequests.length; ri++) {
      const req = activeRequests[ri];
      const key = `${req.model} (${req.provider})`;
      const speed = speedMap[key] || 0.5;
      const color = vividColor(key);
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

    // Space layout: bigger stars orbit closer to the sun, smaller ones farther
    // out, with a 6-12px edge-to-edge gap between neighbouring orbits.
    // ponytail: one ring per distinct star size; a pile of distinct prices can
    // push the outer rings past the canvas — quantize sizes into bands then.
    const sizes = [...new Set(active.map((d) => d.r))].sort((a, b) => b - a);
    const offsetBySize = new Map();
    if (sizes.length) {
      let offset = 6 + sizes[0]; // 6px clearance from the sun for the biggest ring
      offsetBySize.set(sizes[0], offset);
      for (let i = 1; i < sizes.length; i++) {
        offset += sizes[i - 1] + sizes[i] + ORBIT_EDGE_GAP;
        offsetBySize.set(sizes[i], offset);
      }
    }
    for (const dot of active) dot.orbitOffset = offsetBySize.get(dot.r);

    const completed = [];
    let placedCompleted = 0;
    for (const entry of chartData) {
      if (placedCompleted >= MAX_COMPLETED_DOTS) break;
      const done = Math.max(0, entry.requests - (activeByKey[entry.value] || 0));
      const count = Math.min(done, MAX_COMPLETED_DOTS - placedCompleted);
      const baseR = priceRadius(entry.provider, entry.name, false);
      for (let i = 0; i < count; i++) {
        completed.push({
          angle: Math.random() * RADIAN,
          distFactor: Math.random(),
          r: baseR * (0.8 + Math.random() * 0.4),
          angularSpeed: (Math.random() - 0.5) * 0.15,
          phase: Math.random() * RADIAN,
          twinkleSpeed: 0.002 + Math.random() * 0.004,
        });
      }
      placedCompleted += count;
    }

    dotsRef.current = { active, completed };
  }, [activeRequests, speedMap, chartData]);

  const hasData = chartData.length > 0 || totalActive > 0;

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
  }, [hasData]);

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
    const scatterMin = outerR + 6;
    const scatterMax = Math.min(maxR * 0.92, maxR - 4);
    dimsRef.current = { cx, cy, innerR, outerR };

    let last = performance.now();

    const draw = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      ctx.clearRect(0, 0, width, height);

      if (chartData.length > 0 && totalRequests > 0) {
        let start = -Math.PI / 2;
        const arcs = [];
        const pctFontSize = Math.max(8, (outerR - innerR) * 0.42);
        chartData.forEach((entry) => {
          const slice = (entry.requests / totalRequests) * RADIAN;
          const mid = start + slice / 2;
          const hovered = hoverRef.current === entry.value;
          ctx.beginPath();
          ctx.moveTo(cx + innerR * Math.cos(start), cy + innerR * Math.sin(start));
          ctx.arc(cx, cy, outerR, start, start + slice);
          ctx.arc(cx, cy, innerR, start + slice, start, true);
          ctx.closePath();
          ctx.fillStyle = entry.color;
          ctx.fill();
          if (hovered) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          // Draw percentage label if the slice is wide enough
          const pct = (entry.requests / totalRequests) * 100;
          if (slice > 0.25) {
            const labelR = (innerR + outerR) / 2;
            const lx = cx + labelR * Math.cos(mid);
            const ly = cy + labelR * Math.sin(mid);
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.font = `600 ${pctFontSize}px ui-sans-serif, system-ui`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(`${pct.toFixed(0)}%`, lx, ly);
          }
          arcs.push({ start, end: start + slice, mid, entry });
          start += slice;
        });
        arcsRef.current = arcs;
      } else {
        arcsRef.current = [];
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
        dot.angle += dot.angularSpeed * dt;
        if (dot.angle > RADIAN) dot.angle -= RADIAN;
        if (dot.angle < 0) dot.angle += RADIAN;

        const twinkle = 0.5 + 0.5 * Math.sin(now * dot.twinkleSpeed + dot.phase);
        ctx.globalAlpha = 0.35 + 0.45 * twinkle;
        ctx.fillStyle = "rgba(107, 114, 126, 1)";
        const dist = scatterMin + dot.distFactor * (scatterMax - scatterMin);
        const x = cx + dist * Math.cos(dot.angle);
        const y = cy + dist * Math.sin(dot.angle);
        ctx.beginPath();
        ctx.arc(x, y, dot.r, 0, RADIAN);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      ctx.shadowBlur = 16;
      const { active } = dotsRef.current;
      active.forEach((dot) => {
        dot.angle += dot.speed * dt;
        if (dot.angle > RADIAN) dot.angle -= RADIAN;

        const orbitR = outerR + (dot.orbitOffset || 0);
        const x = cx + orbitR * Math.cos(dot.angle);
        const y = cy + orbitR * Math.sin(dot.angle);

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

  const handleMouseMove = useCallback((e) => {
    const { cx, cy, innerR, outerR } = dimsRef.current;
    if (!cx || arcsRef.current.length === 0) { hoverRef.current = null; setHover(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < innerR || dist > outerR) { hoverRef.current = null; setHover(null); return; }
    let angle = Math.atan2(dy, dx);
    for (const arc of arcsRef.current) {
      if (angle < arc.start) angle += RADIAN;
      if (angle >= arc.start && angle < arc.end) {
        hoverRef.current = arc.entry.value;
        setHover({ entry: arc.entry, x: mx, y: my });
        return;
      }
    }
    hoverRef.current = null;
    setHover(null);
  }, []);

  const handleMouseLeave = useCallback(() => { hoverRef.current = null; setHover(null); }, []);

  const successRate = hover?.entry
    ? (hover.entry.requests > 0 ? ((hover.entry.successCount / hover.entry.requests) * 100).toFixed(0) : null)
    : null;
  const hoverPct = hover?.entry && totalRequests > 0
    ? ((hover.entry.requests / totalRequests) * 100).toFixed(1)
    : null;

  if (chartData.length === 0 && totalActive === 0) {
    return (
      <div className="h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px] flex items-center justify-center text-text-muted text-sm">
        No usage
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-border bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
          style={{
            left: Math.min(hover.x + 14, (dims.width || 999) - 180),
            top: Math.max(hover.y - 10, 4),
            maxWidth: 180,
          }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-text-main">
            <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: hover.entry.color }} />
            <span className="truncate">{hover.entry.name}</span>
          </div>
          {hover.entry.provider && (
            <p className="text-text-muted">{hover.entry.provider}</p>
          )}
          <div className="mt-1 space-y-0.5 font-mono text-[11px] text-text-muted">
            <p>Requests: <span className="text-text-main">{hover.entry.requests.toLocaleString()}</span></p>
            <p>Share: <span className="text-text-main">{hoverPct}%</span></p>
            {successRate != null && (
              <p>Success: <span className={Number(successRate) >= 95 ? "text-success" : Number(successRate) >= 80 ? "text-warning" : "text-error"}>{successRate}%</span></p>
            )}
            {hover.entry.tokensPerSecond > 0 && (
              <p>Speed: <span className="text-text-main">{hover.entry.tokensPerSecond.toFixed(1)} t/s</span></p>
            )}
          </div>
        </div>
      )}
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
