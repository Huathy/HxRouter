"use client";

import { Card, Toggle } from "@/shared/components";

export default function TokenSaverSettings({
  rtkEnabled,
  handleRtkEnabled,
  compressionEnabled,
  handleCompressionEnabled,
  cavemanEnabled,
  visibleCavemanLevels,
  handleCavemanLevel,
  cavemanLevel,
  cavemanLevels,
  handleCavemanEnabled,
  ponytailEnabled,
  ponytailLevels,
  handlePonytailLevel,
  ponytailLevel,
  handlePonytailEnabled,
  pxpipeChipClass,
  pxpipeStatusLabel,
  setShowPxpipeModal,
  pxpipeStatus,
  pxpipeEnabled,
  handlePxpipeEnabled,
}) {
  return (
    <Card id="rtk">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">
            bolt
          </span>
          Token Saver
        </h2>
      </div>
      <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Compress tool output{" "}
            <a
              href="https://github.com/rtk-ai/rtk"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-normal text-primary underline hover:opacity-80"
            >
              (RTK)
            </a>
          </p>
          <p className="text-sm text-text-muted">
            git/grep/ls/tree/logs → 60-90% fewer input tokens
          </p>
        </div>
        <Toggle
          checked={rtkEnabled}
          onChange={() => handleRtkEnabled(!rtkEnabled)}
        />
      </div>
      <div className="flex items-center justify-between py-4 gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Compress context locally</p>
          <p className="text-sm text-text-muted mt-1">
            Removes repeated system and tool context in-process before routing
          </p>
        </div>
        <Toggle
          checked={compressionEnabled}
          onChange={() => handleCompressionEnabled(!compressionEnabled)}
        />
      </div>
      <div className="flex items-center justify-between pt-4 border-t border-border gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Compress LLM output{" "}
            <a
              href="https://github.com/JuliusBrussee/caveman"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-normal text-primary underline hover:opacity-80"
            >
              (Caveman)
            </a>
          </p>
          <p className="text-sm text-text-muted">
            Terse-style system prompt → ~65% fewer output tokens (up to 87%)
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {cavemanEnabled && (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5">
                {visibleCavemanLevels.map((lvl) => (
                  <button
                    key={lvl.id}
                    onClick={() => handleCavemanLevel(lvl.id)}
                    className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                      cavemanLevel === lvl.id
                        ? "bg-primary text-white border-primary"
                        : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                    }`}
                    title={lvl.desc}
                  >
                    {lvl.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-primary">
                {cavemanLevels.find((lvl) => lvl.id === cavemanLevel)?.desc}
              </p>
            </div>
          )}
          <Toggle
            checked={cavemanEnabled}
            onChange={() => handleCavemanEnabled(!cavemanEnabled)}
          />
        </div>
      </div>
      <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Lazy senior dev{" "}
            <a
              href="https://github.com/DietrichGebert/ponytail"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-normal text-primary underline hover:opacity-80"
            >
              (Ponytail)
            </a>
          </p>
          <p className="text-sm text-text-muted">
            Bias the model toward minimal code: YAGNI, reuse stdlib,
            deletion over addition
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {ponytailEnabled && (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5">
                {ponytailLevels.map((lvl) => (
                  <button
                    key={lvl.id}
                    onClick={() => handlePonytailLevel(lvl.id)}
                    className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                      ponytailLevel === lvl.id
                        ? "bg-primary text-white border-primary"
                        : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                    }`}
                    title={lvl.desc}
                  >
                    {lvl.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-primary">
                {ponytailLevels.find((lvl) => lvl.id === ponytailLevel)?.desc}
              </p>
            </div>
          )}
          <Toggle
            checked={ponytailEnabled}
            onChange={() => handlePonytailEnabled(!ponytailEnabled)}
          />
        </div>
      </div>
      {/* PXPIPE integration card */}
      <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <p className="font-medium">
              Compress prompts as images{" "}
              <a
                href="https://github.com/teamchong/pxpipe"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (PXPIPE)
              </a>
            </p>
            <span className={`text-xs px-2 py-0.5 rounded ${pxpipeChipClass}`}>
              {pxpipeStatusLabel}
            </span>
            <button
              type="button"
              onClick={() => setShowPxpipeModal(true)}
              className="text-xs text-primary underline hover:opacity-80"
            >
              {pxpipeStatus.installed ? "Manage" : "Setup"}
            </button>
            <a
              href="/dashboard/pxpipe"
              className="text-xs text-primary underline hover:opacity-80"
            >
              Dashboard
            </a>
          </div>
          <p className="text-sm text-text-muted mt-1">
            Transforms large textual context into optimized images before
            sending to the LLM. Ideal for huge prompts, tool outputs and long
            conversations.
          </p>
        </div>
        <Toggle
          checked={pxpipeEnabled}
          disabled={!pxpipeStatus.installed}
          onChange={() => handlePxpipeEnabled(!pxpipeEnabled)}
        />
      </div>
    </Card>
  );
}
