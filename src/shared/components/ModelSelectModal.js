"use client";

import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";
import { computeGroupedModels } from "@/shared/components/modelSelectUtils";
import { fetchCachedJson, invalidateModelSelectCache, syncCatalogVersion } from "@/shared/utils/modelSelectCache";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter(id => FREE_PROVIDERS[id].noAuth);

function ModelButton({ model, isSelected, isPlaceholder, addedModelValues, onSelect, getCaps }) {
  return (
    <button
      key={model.value}
      onClick={() => onSelect(model)}
      title={isPlaceholder ? "Select to pre-fill, then edit model ID in the input" : undefined}
      className={`
        px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer
        ${isPlaceholder
          ? "border-dashed border-border text-text-muted hover:border-primary/50 hover:text-primary bg-surface italic"
          : isSelected
            ? "bg-primary text-white border-primary"
            : addedModelValues.includes(model.value)
              ? "bg-primary border-primary text-white hover:bg-primary-hover"
              : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
        }
      `}
    >
      <span className="flex items-center gap-1">
        {addedModelValues.includes(model.value) && !isPlaceholder && (
          <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
        )}
        {isPlaceholder ? (
          <>
            <span className="material-symbols-outlined text-[11px]">edit</span>
            {model.name}
          </>
        ) : model.isCustom ? (
          <>
            {model.name}
            <span className="text-[9px] opacity-60 font-normal">custom</span>
            <CapacityBadges caps={getCaps(model.value)} />
          </>
        ) : (
          <>
            {model.name}
            <CapacityBadges caps={getCaps(model.value)} />
          </>
        )}
      </span>
    </button>
  );
}

function CollapsibleModelGroup({ providerId, group, selectedModel, addedModelValues, onSelect, getCaps }) {
  const wrapRef = useRef(null);
  const [clipHeight, setClipHeight] = useState(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // Measure the top of the third visual row so the collapsed view clips to two
  // rows. Every button always renders (collapse is pure CSS clipping via
  // max-height/overflow-hidden), so clipping never changes children offsetTop and
  // re-measuring yields the same value — the previous implementation removed the
  // clipped buttons from the DOM, which shrank the measured row count and flipped
  // the collapse flag back, producing an endless expand/collapse loop.
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    // offsetTop is relative to the shared offsetParent, so subtract the wrapper's
    // own offset to get each button's row position relative to the clip container.
    const base = el.offsetTop;
    const tops = Array.from(el.children, (btn) => Math.round(btn.offsetTop - base));
    const distinctTops = [...new Set(tops)].sort((a, b) => a - b);
    const nextClip = distinctTops.length > 2 ? distinctTops[2] : null;
    const nextHidden = nextClip == null ? 0 : tops.filter((top) => top >= nextClip).length;
    setClipHeight((prev) => (prev === nextClip ? prev : nextClip));
    setHiddenCount((prev) => (prev === nextHidden ? prev : nextHidden));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, group.models.length, group.name]);

  const collapsible = clipHeight != null;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5">
        <ProviderIcon
          src={`/providers/${providerId}.webp`}
          alt={group.name}
          size={14}
          fallbackText={(group.name || providerId).slice(0, 2).toUpperCase()}
          fallbackColor={group.color}
        />
        <span className="text-xs font-medium text-primary">
          {group.name}
        </span>
        <span className="text-[10px] text-text-muted">
          ({group.models.length})
        </span>
        {collapsible && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto flex items-center gap-1 text-[11px] text-text-muted hover:text-primary"
          >
            <span className="material-symbols-outlined text-[14px]">
              {expanded ? "expand_less" : "expand_more"}
            </span>
            {expanded ? "收起" : `展开(+${hiddenCount})`}
          </button>
        )}
      </div>
      <div
        ref={wrapRef}
        className="flex flex-wrap gap-1.5"
        style={collapsible && !expanded ? { maxHeight: clipHeight, overflow: "hidden" } : undefined}
      >
        {group.models.map((model) => (
          <ModelButton
            key={model.value}
            model={model}
            isSelected={selectedModel === model.value}
            isPlaceholder={model.isPlaceholder}
            addedModelValues={addedModelValues}
            onSelect={onSelect}
            getCaps={getCaps}
          />
        ))}
      </div>
    </div>
  );
}

export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  selectedModel,
  activeProviders = [],
  title = "Select Model",
  modelAliases = {},
  kindFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
  size = "md",
}) {
  // Filter activeProviders by serviceKinds when kindFilter set (e.g. "webSearch", "webFetch")
  const filteredActiveProviders = useMemo(() => {
    if (!kindFilter) return activeProviders;
    return activeProviders.filter((p) => {
      const info = AI_PROVIDERS[p.provider];
      const kinds = info?.serviceKinds || ["llm"];
      return kinds.includes(kindFilter);
    });
  }, [activeProviders, kindFilter]);
  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState("");
  const [combos, setCombos] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [disabledModels, setDisabledModels] = useState({});
  const [cursorModels, setCursorModels] = useState([]);
  const [kiloFreeModels, setKiloFreeModels] = useState([]);

  // Cursor exposes the usable catalog per account. Keep the static catalog only
  // as a fallback, since it quickly becomes stale and different accounts can
  // have different model entitlements.
  const cursorConnectionIds = useMemo(
    () => activeProviders
      .filter((provider) => provider.provider === "cursor" && provider.id)
      .map((provider) => provider.id),
    [activeProviders],
  );
  const kiloConnectionActive = useMemo(
    () => activeProviders.some((p) => p.provider === "kilocode"),
    [activeProviders],
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshData = useCallback(async ({ force = false } = {}) => {
    try {
      const [combosRes, providerNodesRes, customRes, disabledRes] = await Promise.all([
        fetchCachedJson("/api/combos", { force }),
        fetchCachedJson("/api/provider-nodes", { force }),
        fetchCachedJson("/api/models/custom", { force }),
        fetchCachedJson("/api/models/disabled", { force }),
      ]);
      if (!mountedRef.current) return;
      setCombos(combosRes.combos || []);
      setProviderNodes(providerNodesRes.nodes || []);
      setCustomModels(customRes.models || []);
      setDisabledModels(disabledRes.disabled || {});

      // Per-account catalogs (Cursor) and the dynamic Kilo free list are fetched
      // separately because they are only relevant when those providers connect.
      const cursorLists = cursorConnectionIds.length > 0
        ? await Promise.all(cursorConnectionIds.map((connectionId) =>
            fetchCachedJson(`/api/providers/${connectionId}/models`, { force })
              .then((data) => (Array.isArray(data.models) ? data.models : []))
              .catch(() => [])
          ))
        : [];
      if (!mountedRef.current) return;
      const seen = new Set();
      setCursorModels(cursorLists.flat().filter((model) => {
        if (!model?.id || seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      }));

      if (kiloConnectionActive) {
        const kiloData = await fetchCachedJson("/api/providers/kilo/free-models", { force })
          .catch(() => ({ models: [] }));
        if (!mountedRef.current) return;
        setKiloFreeModels(Array.isArray(kiloData.models) ? kiloData.models : []);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      console.error("Error fetching selector catalog:", err);
    }
  }, [cursorConnectionIds, kiloConnectionActive]);

  useEffect(() => {
    // Bootstrap fetch on open; refreshData writes fetched data into state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOpen) refreshData();
  }, [isOpen, refreshData]);

  // Invalidate the shared catalog cache and refresh whenever another dashboard
  // page edits providers/combos/models. Backed by the SSE stream plus the
  // customModelChanged window event used by the providers pages.
  useEffect(() => {
    if (!isOpen || typeof EventSource === "undefined") return undefined;

    let source;
    try {
      source = new EventSource("/api/models/events");
    } catch {
      return undefined;
    }
    let debounce = null;
    const scheduleRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        invalidateModelSelectCache();
        refreshData({ force: true });
      }, 200);
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "init") {
          if (syncCatalogVersion(payload.version)) scheduleRefresh();
        } else if (payload.type === "changed") {
          scheduleRefresh();
        }
      } catch {
        // non-JSON or ping — ignore
      }
    };

    const onCustomModelChanged = () => scheduleRefresh();
    window.addEventListener("customModelChanged", onCustomModelChanged);

    return () => {
      if (debounce) clearTimeout(debounce);
      source.close();
      window.removeEventListener("customModelChanged", onCustomModelChanged);
    };
  }, [isOpen, refreshData]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    invalidateModelSelectCache();
    try {
      await refreshData({ force: true });
    } finally {
      setIsRefreshing(false);
    }
  };

  const allProviders = useMemo(() => ({ ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS }), []);

  const groupedModels = useMemo(() => computeGroupedModels({
    filteredActiveProviders,
    activeProviders,
    kindFilter,
    providerNodes,
    customModels,
    disabledModels,
    modelAliases,
    allProviders,
    cursorModels,
    kiloFreeModels,
  }), [filteredActiveProviders, activeProviders, kindFilter, providerNodes, customModels, disabledModels, modelAliases, allProviders, cursorModels, kiloFreeModels]);



  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo(() => {
    if (kindFilter) return [];
    if (!searchQuery.trim()) return combos;
    const query = searchQuery.toLowerCase();
    return combos.filter(c => c.name.toLowerCase().includes(query));
  }, [combos, searchQuery, kindFilter]);

  // Sort models alphabetically, with added models floated to top
  const sortModels = (models) => {
    const added = models.filter(m => addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
    const rest = models.filter(m => !addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
    return [...added, ...rest];
  };

  // Filter models by search query
  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered = {};
    Object.entries(groupedModels).forEach(([providerId, group]) => {
      let models = group.models;
      if (query) {
        const providerNameMatches = group.name.toLowerCase().includes(query);
        models = models.filter(
          (m) =>
            m.name.toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query)
        );
        if (models.length === 0 && !providerNameMatches) return;
      }
      filtered[providerId] = {
        ...group,
        models: sortModels(models),
      };
    });

    return filtered;
  }, [groupedModels, searchQuery, addedModelValues]);

  const handleSelect = (model) => {
    const value = model?.value || model?.name || model;
    const isAdded = addedModelValues.includes(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setSearchQuery("");
      }}
      title={title}
      size={size}
      className="p-4!"
      footer={null}
    >
      {/* Info bar */}
      <div className="flex items-center gap-2 mb-3 px-2.5 py-2 bg-primary/8 border border-primary/20 rounded-lg text-xs text-text-muted">
        <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: "14px" }}>info</span>
        <span>Click to add, click again to remove. Changes are saved automatically.</span>
      </div>

      {/* Search - compact */}
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
            search
          </span>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <button
          onClick={handleManualRefresh}
          disabled={isRefreshing}
          className="shrink-0 rounded border border-border bg-surface p-1.5 text-text-muted hover:text-primary hover:border-primary/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Refresh from server"
        >
          <span className="material-symbols-outlined text-[16px]">
            {isRefreshing ? "hourglass_simple" : "refresh"}
          </span>
        </button>
      </div>

      {/* Models grouped by provider - compact */}
      <div className="max-h-[400px] overflow-y-auto space-y-3">
        {/* Combos section - always first */}
        {filteredCombos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5">
              <span className="material-symbols-outlined text-primary text-[14px]">layers</span>
              <span className="text-xs font-medium text-primary">Combos</span>
              <span className="text-[10px] text-text-muted">({filteredCombos.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filteredCombos.map((combo) => {
                const isSelected = selectedModel === combo.name;
                return (
                  <button
                    key={combo.id}
                    onClick={() => handleSelect({ id: combo.name, name: combo.name, value: combo.name })}
                    className={`
                      px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer flex items-center gap-1
                      ${isSelected
                        ? "bg-primary text-white border-primary"
                        : addedModelValues.includes(combo.name)
                          ? "bg-primary border-primary text-white hover:bg-primary-hover"
                          : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    {addedModelValues.includes(combo.name) && (
                      <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                    )}
                    {combo.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Provider models */}
        {Object.entries(filteredGroups).map(([pid, group]) => (
          <CollapsibleModelGroup
            key={pid}
            providerId={pid}
            group={group}
            selectedModel={selectedModel}
            addedModelValues={addedModelValues}
            onSelect={handleSelect}
            getCaps={getCaps}
          />
        ))}

        {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (
          <div className="text-center py-4 text-text-muted">
            <span className="material-symbols-outlined text-2xl mb-1 block">
              search_off
            </span>
            <p className="text-xs">No models found</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

