"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { probeCliInstalled, readJsoncFile } from "../_shared/cliConfig.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

const PROVIDER_ID = "hxrouter";
// Written before the HxRouter rename; still recognised so an already-configured
// Pi keeps reporting as configured (and DELETE can sweep it).
const LEGACY_PROVIDER_IDS = ["9router", "9Router"];
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

const getAgentModelsPath = () => path.join(os.homedir(), ".pi", "agent", "models.json");
const getRootModelsPath = () => path.join(os.homedir(), ".pi", "models.json");
const checkPiInstalled = () => probeCliInstalled("pi", [getAgentModelsPath(), getRootModelsPath()]);

// Prefer the nested path Pi actually reads, fall back to a flat ~/.pi/models.json
const resolveModelsPath = async () => {
  for (const candidate of [getAgentModelsPath(), getRootModelsPath()]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return getAgentModelsPath();
};

const readConfigAt = readJsoncFile;

const hasRouterConfig = (config) => {
  const providers = config?.providers;
  if (!providers) return false;
  if (providers[PROVIDER_ID]?.baseUrl) return true;
  if (LEGACY_PROVIDER_IDS.some((id) => providers[id]?.baseUrl)) return true;
  return Object.values(providers).some((provider) => provider?.baseUrl?.includes("20128"));
};

const toModelEntry = (entry) => {
  if (typeof entry === "string") {
    return { id: entry, name: entry, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS };
  }
  const id = entry?.id || "provider/model-id";
  return {
    id,
    name: entry?.name || id,
    contextWindow: entry?.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry?.maxTokens || DEFAULT_MAX_TOKENS,
  };
};

export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const installed = await checkPiInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "Pi CLI is not installed" });
    }

    const configPath = await resolveModelsPath();
    const config = await readConfigAt(configPath);

    return NextResponse.json({
      installed: true,
      config,
      hasHxRouter: hasRouterConfig(config),
      // Legacy response alias retained for older clients.
      has9Router: hasRouterConfig(config),
      configPath,
    });
  } catch (error) {
    console.log("Error checking pi settings:", error);
    return NextResponse.json({ error: { message: "Failed to check pi settings" } }, { status: 500 });
  }
}

export async function POST(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey, model, models } = body || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const configPath = await resolveModelsPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    const existing = (await readConfigAt(configPath)) || {};
    if (!existing.providers) existing.providers = {};
    // A legacy provider block would otherwise survive alongside the canonical one.
    for (const legacyId of LEGACY_PROVIDER_IDS) delete existing.providers[legacyId];

    const selected = Array.isArray(models) && models.length > 0 ? models : [model || "provider/model-id"];
    existing.providers[PROVIDER_ID] = {
      baseUrl: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      apiKey: apiKey || "sk_HxRouter",
      api: "openai-completions",
      models: selected.map(toModelEntry),
    };

    await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

    return NextResponse.json({
      success: true,
      message: "Pi settings applied! Use /model in Pi to select the HxRouter model.",
      configPath,
    });
  } catch (error) {
    console.log("Error updating pi settings:", error);
    return NextResponse.json({ error: { message: "Failed to update pi settings" } }, { status: 500 });
  }
}

export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const configPath = await resolveModelsPath();
    const existing = await readConfigAt(configPath);
    if (!existing) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    if (existing.providers) {
      delete existing.providers[PROVIDER_ID];
      for (const legacyId of LEGACY_PROVIDER_IDS) delete existing.providers[legacyId];
      if (Object.keys(existing.providers).length === 0) delete existing.providers;
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }

    return NextResponse.json({ success: true, message: "HxRouter removed from Pi" });
  } catch (error) {
    console.log("Error resetting pi settings:", error);
    return NextResponse.json({ error: { message: "Failed to reset pi settings" } }, { status: 500 });
  }
}
