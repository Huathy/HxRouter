"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input, Modal, Toggle } from "@/shared/components";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import { usePxpipe } from "./usePxpipe";
import TokenSaverSettings from "./TokenSaverSettings";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

export default function TokenSaverClient() {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [compressionEnabled, setCompressionEnabled] = useState(false);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [pxpipeEnabled, setPxpipeEnabled] = useState(false);
  const [guards, setGuards] = useState({
    loopGuard: true,
    circuitBreaker: true,
    semaphore: true,
  });
  const [locale, setLocale] = useState(getCurrentLocale);

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  const pxpipe = usePxpipe({ patchSetting, setPxpipeEnabled });
  const {
    pxpipeStatus,
    pxpipeHealth,
    showModal: showPxpipeModal,
    setShowModal: setShowPxpipeModal,
    actionLoading: pxpipeActionLoading,
    actionError: pxpipeActionError,
    minChars: pxpipeMinChars,
    setMinChars: setPxpipeMinChars,
    refresh: refreshPxpipeStatus,
    health: runPxpipeHealth,
    action: pxpipeAction,
    setEnabled: handlePxpipeEnabled,
    blurMinChars: handlePxpipeMinCharsBlur,
  } = pxpipe;

  useEffect(() => onLocaleChange(() => setLocale(getCurrentLocale())), []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);
  const effectiveCavemanLevel = !isWenyanLocale && CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)?.wenyan
    ? "ultra"
    : cavemanLevel;

  useEffect(() => {
    if (effectiveCavemanLevel !== cavemanLevel) patchSetting({ cavemanLevel: effectiveCavemanLevel });
  }, [cavemanLevel, effectiveCavemanLevel]);

  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handlePonytailEnabled = (value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  };

  const handlePonytailLevel = (level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  };

  const updateGuard = (key, value) => {
    setGuards((prev) => ({ ...prev, [key]: value }));
    patchSetting({ [`${key}Enabled`]: value });
  };

  const handleCompressionEnabled = (value) => {
    setCompressionEnabled(value);
    patchSetting({ compressionEnabled: value });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setCompressionEnabled(!!data.compressionEnabled);
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setPxpipeEnabled(!!data.pxpipeEnabled);
          if (typeof data.pxpipeMinChars === "number") setPxpipeMinChars(data.pxpipeMinChars);
          setGuards({
            loopGuard: data.loopGuardEnabled !== false,
            circuitBreaker: data.circuitBreakerEnabled !== false,
            semaphore: data.semaphoreEnabled !== false,
          });
          refreshPxpipeStatus().then(runPxpipeHealth);
        }
      } catch {}
    };
    loadSettings();
  }, [refreshPxpipeStatus, runPxpipeHealth, setPxpipeMinChars]);

  const pxpipeHealthy = pxpipeHealth?.healthy === true;
  const pxpipeStatusLabel = pxpipeStatus.loading
    ? "Checking…"
    : pxpipeStatus.installing
      ? "Installing…"
      : !pxpipeStatus.installed
        ? "Not installed"
        : pxpipeHealthy
          ? "Healthy"
          : pxpipeStatus.running
            ? "Running"
            : "Stopped";
  const pxpipeChipClass =
    pxpipeHealthy || pxpipeStatus.running
      ? "bg-success/15 text-success"
      : "bg-warning/15 text-warning";

  return (
    <div className="space-y-6 p-6">
      <TokenSaverSettings
        rtkEnabled={rtkEnabled}
        handleRtkEnabled={handleRtkEnabled}
        compressionEnabled={compressionEnabled}
        handleCompressionEnabled={handleCompressionEnabled}
        cavemanEnabled={cavemanEnabled}
        visibleCavemanLevels={visibleCavemanLevels}
        handleCavemanLevel={handleCavemanLevel}
        cavemanLevel={effectiveCavemanLevel}
        cavemanLevels={CAVEMAN_LEVELS}
        handleCavemanEnabled={handleCavemanEnabled}
        ponytailEnabled={ponytailEnabled}
        ponytailLevels={PONYTAIL_LEVELS}
        handlePonytailLevel={handlePonytailLevel}
        ponytailLevel={ponytailLevel}
        handlePonytailEnabled={handlePonytailEnabled}
        pxpipeChipClass={pxpipeChipClass}
        pxpipeStatusLabel={pxpipeStatusLabel}
        setShowPxpipeModal={setShowPxpipeModal}
        pxpipeStatus={pxpipeStatus}
        pxpipeEnabled={pxpipeEnabled}
        handlePxpipeEnabled={handlePxpipeEnabled}
      />

      <Card id="guards">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              shield
            </span>
            Guards & Shields
          </h2>
        </div>
        
        {/* Loop Guard */}
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Loop Guard</p>
            <p className="text-sm text-text-muted">
              Detects repeating tool call sequences and text-only planning loops.
              Injects corrections to prevent infinite agent run-loops.
            </p>
          </div>
          <Toggle
            checked={guards.loopGuard}
            onChange={() => updateGuard("loopGuard", !guards.loopGuard)}
          />
        </div>

        {/* Circuit Breaker */}
        <div className="flex items-center justify-between py-4 border-b border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Circuit Breaker</p>
            <p className="text-sm text-text-muted">
              Temporarily halts upstream calls for offline or failing providers
              to prevent spamming and conserve connection resource.
            </p>
          </div>
          <Toggle
            checked={guards.circuitBreaker}
            onChange={() => updateGuard("circuitBreaker", !guards.circuitBreaker)}
          />
        </div>

        {/* Semaphore Limiter */}
        <div className="flex items-center justify-between py-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Semaphore (Concurrency Limiter)</p>
            <p className="text-sm text-text-muted">
              Enforces simultaneous request limits per provider account. Prevents
              rate-limits (429) and account blockings.
            </p>
          </div>
          <Toggle
            checked={guards.semaphore}
            onChange={() => updateGuard("semaphore", !guards.semaphore)}
          />
        </div>
      </Card>

      <Modal
        isOpen={showPxpipeModal}
        title={pxpipeStatus.installed ? "PXPIPE" : "Setup PXPIPE"}
        onClose={() => setShowPxpipeModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Compress prompts using multimodal encoding. Runs in-process — no
            extra server or environment variables required.
          </p>
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span className={pxpipeHealthy || pxpipeStatus.running ? "text-success" : "text-warning"}>
              {pxpipeStatusLabel}
              {pxpipeStatus.version ? ` · v${pxpipeStatus.version}` : ""}
            </span>
          </div>
          {pxpipeHealth?.checks?.length > 0 && (
            <div className="flex flex-col gap-1 rounded border border-border p-3">
              <p className="text-sm font-medium mb-1">Health check</p>
              {pxpipeHealth.checks.map((check) => (
                <div key={check.id} className="flex items-center justify-between text-xs">
                  <span className={check.ok ? "text-success" : "text-warning"}>
                    {check.ok ? "●" : "○"} {check.label}
                  </span>
                  {check.detail && (
                    <span className="text-text-muted font-mono truncate max-w-[50%]">{check.detail}</span>
                  )}
                </div>
              ))}
              {pxpipeHealth.error && (
                <p className="text-xs text-warning mt-1">{pxpipeHealth.error}</p>
              )}
            </div>
          )}
          {!pxpipeStatus.installed ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-warning">PXPIPE is not installed.</p>
              <Button
                onClick={() => pxpipeAction("install")}
                fullWidth
                disabled={pxpipeActionLoading || pxpipeStatus.installing}
              >
                {pxpipeActionLoading || pxpipeStatus.installing ? "Installing…" : "Install"}
              </Button>
              <p className="text-xs text-text-muted">
                Installs the npm package <code className="font-mono">pxpipe-proxy</code> into
                the 9Router data directory. May take a few minutes.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {pxpipeStatus.running ? (
                <>
                  <Button onClick={() => pxpipeAction("restart")} variant="ghost" disabled={pxpipeActionLoading}>
                    Restart
                  </Button>
                  <Button onClick={() => pxpipeAction("stop")} variant="ghost" disabled={pxpipeActionLoading}>
                    Stop
                  </Button>
                </>
              ) : (
                <Button onClick={() => pxpipeAction("start")} disabled={pxpipeActionLoading}>
                  {pxpipeActionLoading ? "Starting…" : "Start"}
                </Button>
              )}
              <Button onClick={() => pxpipeAction("install")} variant="ghost" disabled={pxpipeActionLoading}>
                Repair
              </Button>
              <a
                href="/dashboard/pxpipe#logs"
                className="col-span-2 rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
              >
                Open Logs
              </a>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Minimum prompt size (chars)</p>
            <Input
              value={String(pxpipeMinChars)}
              onChange={(e) => setPxpipeMinChars(e.target.value)}
              onBlur={handlePxpipeMinCharsBlur}
              placeholder="25000"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Requests smaller than this bypass PXPIPE and are sent as-is.
            </p>
          </div>
          {pxpipeActionError && (
            <p className="text-sm text-warning">{pxpipeActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshPxpipeStatus().then(runPxpipeHealth)}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button onClick={() => setShowPxpipeModal(false)} fullWidth>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
