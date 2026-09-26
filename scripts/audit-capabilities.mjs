/**
 * Script: audit provider modality/capability declarations against the registry.
 * Read-only: imports the built registry, prints a table, exits 0.
 * Chạy: node scripts/audit-capabilities.mjs
 *
 * Backs two runtime warnings:
 *   L1-5 combo strategy vocabulary  — open-sse/services/combo.js
 *   L1-6 modality strip            — open-sse/handlers/chatCore.js warnStrippedModalities()
 *
 * The L1-6 warning fires per `provider|model|capability` for every model whose
 * resolved capabilities say it cannot read a modality. The STRIP column below
 * counts exactly those models, so a sudden flood of warnings can be traced here
 * first. `STRIP` counts models that would warn; `FULL` counts models that support
 * vision+pdf+audioInput and never warn.
 */
// The repo's package.json has no "type": "module" but open-sse/ is ESM, so Node
// re-parses each imported file and emits this notice. Expected here; keep every
// other warning visible. Installed before the dynamic imports below, because
// static imports would be hoisted and evaluated ahead of any module-body code.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w.name}: ${w.message}`);
});

const { default: REGISTRY } = await import("../open-sse/providers/registry/index.js");
const { getCapabilitiesForModel } = await import("../open-sse/providers/capabilities.js");

// Media declaration keys, mirroring MEDIA_KEYS in open-sse/providers/index.js.
const CONFIG_KEYS = [
  "ttsConfig", "sttConfig", "embeddingConfig", "imageConfig",
  "imageToTextConfig", "videoConfig", "musicConfig", "searchConfig", "fetchConfig",
];
// Capability keys translator/concerns/modality.js can strip.
const STRIPPABLE = ["vision", "pdf", "audioInput"];

// Strategy vocabulary. Source of truth: STRATEGY_OPTIONS in
// src/app/(dashboard)/dashboard/combos/page.js. "fusion" is chat-only.
const STRATEGY_MODALITY_MATRIX = [
  ["fallback", "yes", "yes", "yes", "yes", "yes"],
  ["round-robin", "yes", "yes", "yes", "yes", "yes"],
  ["fusion", "yes", "NO (chat only)", "NO", "NO", "NO"],
];
const MODALITY_HEADERS = ["strategy", "chat", "tts", "search", "image", "fetch"];

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function mediaOf(entry) {
  const fields = entry.media && typeof entry.media === "object" ? entry.media : entry;
  return fields;
}

function chatModelsOf(entry) {
  return Array.isArray(entry.models) ? entry.models : [];
}

function mediaModelsOf(media) {
  let n = 0;
  for (const key of CONFIG_KEYS) {
    const models = media[key]?.models;
    if (Array.isArray(models)) n += models.length;
  }
  return n;
}

// A model is "strip-risk" when it declares no support for at least one modality
// the translator strips — i.e. exactly when chatCore's deduped warn fires.
// Returns per-capability support counts alongside the model lists so the caller
// can aggregate without this function reaching into loop scope.
function stripRisk(entry) {
  const models = chatModelsOf(entry);
  const warnModels = [];
  const full = [];
  const capSupport = new Map(STRIPPABLE.map((c) => [c, 0]));
  let checked = 0;
  for (const m of models) {
    const id = typeof m === "string" ? m : m?.id;
    if (!id) continue;
    const caps = getCapabilitiesForModel(entry.id, id);
    const missing = STRIPPABLE.filter((cap) => caps[cap] === false);
    checked++;
    for (const cap of STRIPPABLE) if (caps[cap] !== false) capSupport.set(cap, capSupport.get(cap) + 1);
    if (missing.length > 0) warnModels.push({ id, missing });
    else full.push(id);
  }
  return { total: models.length, warnModels, full, capSupport, checked };
}

try {
  const kindCounts = new Map();
  const rows = [];
  const stripRows = [];
  const noKind = [];
  const capSupport = new Map(STRIPPABLE.map((c) => [c, 0]));
  let totalWarn = 0, totalMedia = 0, capChecked = 0;

  for (const entry of REGISTRY) {
    const media = mediaOf(entry);
    const kinds = Array.isArray(media.serviceKinds) ? media.serviceKinds : [];
    for (const k of kinds) kindCounts.set(k, (kindCounts.get(k) || 0) + 1);
    if (kinds.length === 0) noKind.push(entry.id);

    const configs = CONFIG_KEYS.filter((k) => media[k]);
    const mediaModels = mediaModelsOf(media);
    const risk = stripRisk(entry);
    totalWarn += risk.warnModels.length;
    totalMedia += mediaModels;
    capChecked += risk.checked;
    for (const cap of STRIPPABLE) capSupport.set(cap, capSupport.get(cap) + risk.capSupport.get(cap));

    rows.push([
      entry.id,
      entry.alias || "-",
      kinds.length ? kinds.join(",") : "(none)",
      configs.length ? configs.map((c) => c.replace("Config", "")).join(",") : "-",
      mediaModels || "-",
      risk.total || "-",
      risk.warnModels.length,
      risk.full.length,
    ]);

    if (risk.warnModels.length > 0) {
      stripRows.push([
        entry.id,
        `${risk.warnModels.length}/${risk.total}`,
        [...new Set(risk.warnModels.flatMap((m) => m.missing))].join(","),
      ]);
    }
  }

  console.log("9router provider capability audit");
  console.log("=".repeat(72));
  console.log("Sources: open-sse/providers/registry/index.js (declarations)");
  console.log("         open-sse/providers/capabilities.js  (resolved capabilities)");
  console.log("Read-only: no network, no writes, no state mutation.\n");

  console.log("Combo strategy vocabulary x modality (open-sse/services/combo.js)");
  console.log("-".repeat(72));
  console.log(renderTable(MODALITY_HEADERS, STRATEGY_MODALITY_MATRIX));
  console.log("  A \"NO\" means handleComboChat cannot run that strategy and the combo");
  console.log("  silently degrades to plain fallback (warned once per combo|strategy|modality|target).\n");

  console.log("Resolved strippable capabilities across all registry chat models");
  console.log("-".repeat(72));
  console.log(renderTable(
    ["capability", "models supporting", "models lacking"],
    STRIPPABLE.map((cap) => [
      cap,
      `${capSupport.get(cap)}/${capChecked}`,
      `${capChecked - capSupport.get(cap)}/${capChecked}`,
    ])
  ));
  console.log("  A \"models lacking\" count near 100% means the modality-strip warn is");
  console.log("  near-universal — high volume, low information. It stays deduplicated");
  console.log("  per provider|model (one line per model, first use in a process).\n");

  console.log("Declared service kinds");
  console.log("-".repeat(72));
  const kindRows = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => [k, n]);
  console.log(renderTable(["kind", "providers"], kindRows));
  console.log(`  (no serviceKinds declared: ${noKind.length}${noKind.length ? " -> " + noKind.slice(0, 12).join(", ") + (noKind.length > 12 ? ", ..." : "") : ""})\n`);

  console.log("Per-provider modality declarations");
  console.log("-".repeat(72));
  console.log(renderTable(
    ["id", "alias", "serviceKinds", "configs", "mediaModels", "chatModels", "STRIP", "FULL"],
    rows
  ));
  console.log(`\n  chatModels=${capChecked}  stripRisk=${totalWarn}  mediaModels=${totalMedia}  providers=${rows.length}\n`);

  console.log("Modality-strip audit — providers that emit the chatCore L1-6 warning");
  console.log("-".repeat(72));
  console.log(renderTable(["id", "strip-risk", "missing caps"], stripRows));
  console.log(`\n  Every model counted above logs one deduped [MODALITY] warn on first use`);
  console.log(`  of provider|model in a process, listing all of its missing caps.`);
  console.log(`  Providers omitted here declare vision+pdf+audioInput for all their models.\n`);

  console.log("Summary");
  console.log("-".repeat(72));
  console.log(`  providers audited           : ${rows.length}`);
  console.log(`  chat models audited         : ${capChecked}`);
  console.log(`  models with >=1 missing cap : ${totalWarn}`);
  console.log(`  media models declared       : ${totalMedia}`);
  console.log(`  providers w/o serviceKinds  : ${noKind.length}`);
  process.exit(0);
} catch (err) {
  console.error(`audit-capabilities failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
}
