"use client";

import PropTypes from "prop-types";
import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";

const EMPTY_PROVIDERS = [];
const EMPTY_REQUESTS = [];
import {
  ReactFlow,
  Handle,
  Position,
  Controls,
  BaseEdge,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

// Force-stop FE animation if a provider stays active longer than this
const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;
// minZoom keeps the ring from auto-fitting into unreadable micro-text when many
// providers are configured; the user can pan for the overflow instead of squinting.
const FIT_VIEW_OPTS = { padding: 0.2, duration: 200, minZoom: 0.75 };

// Fixed chip sizes. The center stays 100x40; providers are compact 80x35 by
// default and scale up while a request is flowing through them.
const ROUTER_NODE_W = 100;
const ROUTER_NODE_H = 40;
const PROVIDER_NODE_W = 80;
const PROVIDER_NODE_H = 35;
const PROVIDER_ACTIVE_SCALE = 1.35;

// Kame + electric particles along active edges
const KAME_PARTICLE_COUNT = 6;
const SPARK_COUNT = 5;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

// Custom provider node - compact fixed chip; scales up while active so the
// label stays legible instead of shrinking with the ring.
function ProviderNode({ data }) {
  const { providerId, label, color, imageUrl, textIcon, active } = data;
  const [imgError, setImgError] = useState(false);
  return (
    <div
      className="relative flex items-center gap-1.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      style={{
        width: PROVIDER_NODE_W,
        height: PROVIDER_NODE_H,
        padding: "0 7px",
        borderColor: active ? color : "var(--color-border)",
        boxShadow: active ? `0 0 16px ${color}55` : "none",
        transform: active ? `scale(${PROVIDER_ACTIVE_SCALE})` : "scale(1)",
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      {/* Provider icon */}
      <div
        className="rounded-md flex items-center justify-center shrink-0"
        style={{ width: 20, height: 20, backgroundColor: `${color}15` }}
      >
        {providerId === "a6api" || providerId === "a6api-cli" ? (
          <span
            className="a6api-custom-logo"
            style={{
              width: "15px",
              height: "15px",
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              position: "relative",
              overflow: "hidden",
              color: "var(--navy, #1F2937)",
              fontSize: "6px",
              fontWeight: "bold",
              letterSpacing: 0,
              background: "radial-gradient(circle at 34% 28%, rgba(255, 255, 255, .38), transparent 22%), conic-gradient(from 210deg, #3157ff, #16b8a6, #74c86a, #3157ff)",
              boxShadow: "0 4px 8px #3157ff38",
              isolation: "isolate",
            }}
          >
            <span>A6</span>
          </span>
        ) : imageUrl && !imgError ? (
          <Image
            src={imageUrl}
            alt={label}
            className="w-4 h-4 rounded-sm object-contain"
            width={16}
            height={16}
            unoptimized
            onError={() => {
              const m = imageUrl?.match(/^\/providers\/([^/]+)\.(png|webp)$/i);
              if (m) markProviderIconMissing(m[1]);
              setImgError(true);
            }}
          />
        ) : (
          <span className="text-[9px] font-bold" style={{ color }}>{textIcon}</span>
        )}
      </div>

      {/* Provider name */}
      <span
        className="min-w-0 flex-1 truncate text-[10px] font-medium leading-none"
        style={{ color: active ? color : "var(--color-text)" }}
      >
        {label}
      </span>

      {/* Active indicator */}
      {active && (
        <span className="absolute -top-1 -right-1 flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
        </span>
      )}
    </div>
  );
}


// Center 9Router node — pulse/glow on card only (no expanding rings)
function RouterNode({ data }) {
  const powering = (data.activeCount || 0) > 0;
  return (
    <div
      className={`relative z-[1] flex items-center justify-center gap-1.5 rounded-xl border-2 ${
        powering
          ? "topology-router-core border-yellow-300 bg-gradient-to-br from-primary/30 via-yellow-400/20 to-cyan-400/25"
          : "border-primary bg-primary/5 shadow-md"
      }`}
      style={{ width: ROUTER_NODE_W, height: ROUTER_NODE_H }}
    >
      <Handle type="source" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <img
        src="/favicon.svg"
        alt="HXAI"
        className={`w-5 h-5 ${powering ? "topology-router-icon" : ""}`}
        loading="lazy"
        decoding="async"
        width={20}
        height={20}
      />
      <span className={`text-sm font-bold ${powering ? "topology-router-label text-yellow-300" : "text-primary"}`}>
        HXAI
      </span>
      {data.activeCount > 0 && (
        <span className="absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full bg-yellow-400 text-black text-[10px] font-bold topology-router-badge">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}


// Active: electric kame beam (multi-layer stroke + sparks). Idle/last/error: solid BaseEdge.
function TopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const active = !!data?.active;
  const stroke = style.stroke || "var(--color-border)";
  const filterId = `topo-electric-${id}`;

  if (!active) {
    return <BaseEdge id={id} path={edgePath} style={{ ...style, stroke }} />;
  }

  return (
    <g className="topology-edge-electric">
      <defs>
        <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="2" result="noise">
            <animate attributeName="baseFrequency" values="0.8;1.4;0.8" dur="0.25s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      {/* Outer electric halo */}
      <path
        d={edgePath}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={10}
        strokeOpacity={0.35}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-halo"
      />
      {/* Mid plasma */}
      <path
        d={edgePath}
        fill="none"
        stroke="#4ade80"
        strokeWidth={5}
        strokeOpacity={0.85}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-plasma"
      />
      {/* Hot white core */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: "#f8fafc", strokeWidth: 2.2, opacity: 1 }}
        className="topology-edge-kame"
      />
      {/* Energy orbs */}
      {Array.from({ length: KAME_PARTICLE_COUNT }, (_, i) => (
        <circle
          key={`${id}-p-${i}`}
          r={i % 2 === 0 ? 4 : 2.5}
          fill={i % 3 === 0 ? "#fde047" : i % 3 === 1 ? "#67e8f9" : "#fff"}
          opacity={0.95}
          style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }}
        >
          <animateMotion
            dur={`${0.4 + i * 0.08}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.09}s`}
          />
        </circle>
      ))}
      {/* Electric sparks (short-lived blink along path) */}
      {Array.from({ length: SPARK_COUNT }, (_, i) => (
        <circle
          key={`${id}-s-${i}`}
          r={1.8}
          fill="#e0f2fe"
          opacity={0}
        >
          <animate
            attributeName="opacity"
            values="0;1;0;0;1;0"
            dur={`${0.35 + (i % 3) * 0.1}s`}
            begin={`${i * 0.07}s`}
            repeatCount="indefinite"
          />
          <animateMotion
            dur={`${0.28 + i * 0.05}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.11}s`}
          />
        </circle>
      ))}
    </g>
  );
}

TopologyEdge.propTypes = {
  id: PropTypes.string,
  sourceX: PropTypes.number,
  sourceY: PropTypes.number,
  targetX: PropTypes.number,
  targetY: PropTypes.number,
  sourcePosition: PropTypes.string,
  targetPosition: PropTypes.string,
  style: PropTypes.object,
  data: PropTypes.object,
};

const nodeTypes = { provider: ProviderNode, router: RouterNode };
const edgeTypes = { topology: TopologyEdge };

// Place N nodes evenly along a circle around the router center.
function buildLayout(providers, activeSet, lastSet, errorSet) {
  const nodeW = PROVIDER_NODE_W;
  const nodeH = PROVIDER_NODE_H;
  const routerW = ROUTER_NODE_W;
  const routerH = ROUTER_NODE_H;
  const nodeGap = 20;

  const count = providers.length;

  // Reserve room for the scaled-up chip so an active node never collides with
  // its neighbors. Radius grows with provider count; the fitView minZoom floor
  // keeps labels readable and lets the user pan across the overflow.
  const nodeSpacing = PROVIDER_NODE_W * PROVIDER_ACTIVE_SCALE + nodeGap;
  const minRadius = (nodeSpacing * count) / (2 * Math.PI);
  const radius = Math.max(150, minRadius);
  if (count === 0) {
    return {
      nodes: [{ id: "router", type: "router", position: { x: -routerW / 2, y: -routerH / 2 }, data: { activeCount: 0 }, draggable: false }],
      edges: [],
    };
  }

  const nodes = [];
  const edges = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  const edgeStyle = (active, last, error) => {
    if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
    if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
    if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
    return { stroke: "var(--color-border)", strokeWidth: 1, opacity: 0.3 };
  };

  providers.forEach((p, i) => {
    const config = getProviderConfig(p.provider);
    const active = activeSet.has(p.provider?.toLowerCase());
    const last = !active && lastSet.has(p.provider?.toLowerCase());
    const error = !active && errorSet.has(p.provider?.toLowerCase());
    const nodeId = `provider-${p.provider}`;
    const data = {
      providerId: p.provider,
      label: (config.name !== p.provider ? config.name : null) || p.nodeName || p.name || p.provider,
      color: config.color || "#6b7280",
      imageUrl: getProviderIconSrc(p.provider),
      textIcon: config.textIcon || (p.provider || "?").slice(0, 2).toUpperCase(),
      active,
    };

    // Distribute evenly starting from top (−π/2), clockwise
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = radius * Math.cos(angle);
    const cy = radius * Math.sin(angle);

    // Pick router handle closest to the node direction
    let sourceHandle, targetHandle;
    if (Math.abs(angle + Math.PI / 2) < Math.PI / 4 || Math.abs(angle - 3 * Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "top"; targetHandle = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "bottom"; targetHandle = "top";
    } else if (cx > 0) {
      sourceHandle = "right"; targetHandle = "left";
    } else {
      sourceHandle = "left"; targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      data,
      draggable: false,
      // Keep the enlarged active chip above its idle neighbors
      zIndex: active ? 10 : 0,
    });

    edges.push({
      id: `e-${nodeId}`,
      type: "topology",
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      // Built-in animated uses stroke-dasharray (CPU-heavy); use particle beam instead
      animated: false,
      data: { active },
      style: edgeStyle(active, last, error),
    });
  });

  return { nodes, edges };
}

export default function ProviderTopology({ providers = EMPTY_PROVIDERS, activeRequests = EMPTY_REQUESTS, lastProvider = "", errorProvider = "" }) {
  // Serialize to stable string keys so useMemo only re-runs when values actually change
  const activeKey = useMemo(
    () => activeRequests.flatMap((r) => { const p = r.provider?.toLowerCase(); return p ? [p] : []; }).sort().join(","),
    [activeRequests]
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";

  const rawActiveSet = useMemo(() => new Set(activeKey ? activeKey.split(",") : []), [activeKey]);
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set(errorKey ? [errorKey] : []), [errorKey]);

  // Track firstSeen per active provider; drop provider if running too long (BE stuck)
  const [firstSeen, setFirstSeen] = useState({});
  const [activeSet, setActiveSet] = useState(new Set());
  const [tick, setTick] = useState(0);

  // Tracks when each provider became active so we can drop providers that
  // are stuck (e.g. backend never marked them done). State (not ref) so
  // downstream useEffects can react to changes.
  useEffect(() => {
    const now = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- updater pattern avoids stale state; cascading renders are intentional here.
    setFirstSeen((prev) => {
      const next = { ...prev };
      for (const p of rawActiveSet) {
        if (!next[p]) next[p] = now;
      }
      for (const p of Object.keys(next)) {
        if (!rawActiveSet.has(p)) delete next[p];
      }
      return next;
    });
  }, [rawActiveSet]);

  useEffect(() => {
    if (rawActiveSet.size === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [rawActiveSet]);

  // Compute filtered activeSet in an effect so Date.now() is not called
  // during render. tick + firstSeen + rawActiveSet all trigger recompute.
  useEffect(() => {
    void tick; // re-run on tick
    const now = Date.now();
    const filtered = new Set();
    for (const p of rawActiveSet) {
      const ts = firstSeen[p];
      if (!ts || now - ts < FE_ACTIVE_TIMEOUT_MS) filtered.add(p);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Date.now() is not allowed during render; computed in effect so render stays pure.
    setActiveSet(filtered);
  }, [rawActiveSet, tick, firstSeen]);

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet),
    [providers, activeSet, lastSet, errorSet]
  );

  // Stable key — only remount when provider list changes
  const providersKey = useMemo(
    () => providers.map((p) => p.provider).sort().join(","),
    [providers]
  );

  const rfInstance = useRef(null);
  const containerRef = useRef(null);
  const onInit = useCallback((instance) => {
    rfInstance.current = instance;
    setTimeout(() => instance.fitView(FIT_VIEW_OPTS), 50);
  }, []);

  // Re-fit on container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (rfInstance.current) rfInstance.current.fitView(FIT_VIEW_OPTS);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-fit when node count/layout changes
  useEffect(() => {
    if (rfInstance.current) {
      const id = setTimeout(() => rfInstance.current.fitView(FIT_VIEW_OPTS), 50);
      return () => clearTimeout(id);
    }
  }, [nodes.length]);

  return (
    <div ref={containerRef} className="h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px]">
      {providers.length === 0 ? (
        <div className="h-full flex items-center justify-center text-text-muted text-sm">
          No providers connected
        </div>
      ) : (
        <ReactFlow
          key={providersKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={FIT_VIEW_OPTS}
          minZoom={0.1}
          maxZoom={2}
          onInit={onInit}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Controls showInteractive={false} className="react-flow-controls-custom" />
        </ReactFlow>
      )}
    </div>
  );
}

