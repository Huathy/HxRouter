"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { probeCliInstalled, readJsoncFile } from "../_shared/cliConfig.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

const PROVIDER_ID = "hxrouter";
// Written before the HxRouter rename; still recognised so an already-configured
// Crush keeps reporting as configured (and DELETE can sweep it).
const LEGACY_PROVIDER_IDS = ["9router", "9Router"];
const DEFAULT_CONTEXT_WINDOW = 128000;

const getCrushConfigPath = () => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "crush", "crush.json");
};

const getCrushDir = () => path.dirname(getCrushConfigPath());

const checkCrushInstalled = () => probeCliInstalled("crush", [getCrushConfigPath()]);
const readConfig = () => readJsoncFile(getCrushConfigPath());

const hasRouterConfig = (config) => {
  const providers = config?.providers;
  if (!providers) return false;
  if (providers[PROVIDER_ID]?.base_url) return true;
  if (LEGACY_PROVIDER_IDS.some((id) => providers[id]?.base_url)) return true;
  return Object.values(providers).some((provider) => provider?.base_url?.includes("20128"));
};

export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const installed = await checkCrushInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "Crush CLI is not installed" });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasHxRouter: hasRouterConfig(config),
      // Legacy response alias retained for older clients.
      has9Router: hasRouterConfig(config),
      configPath: getCrushConfigPath(),
    });
  } catch (error) {
    console.log("Error checking crush settings:", error);
    return NextResponse.json({ error: { message: "Failed to check crush settings" } }, { status: 500 });
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
    const { baseUrl, apiKey, model } = body || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const configPath = getCrushConfigPath();
    await fs.mkdir(getCrushDir(), { recursive: true });

    const existing = (await readConfig()) || {};
    if (!existing.providers) existing.providers = {};
    // A legacy provider block would otherwise survive alongside the canonical one.
    for (const legacyId of LEGACY_PROVIDER_IDS) delete existing.providers[legacyId];

    const modelId = model || "provider/model-id";
    existing.providers[PROVIDER_ID] = {
      type: "openai-compat",
      base_url: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      api_key: apiKey || "sk_HxRouter",
      models: [{ id: modelId, name: modelId, context_window: DEFAULT_CONTEXT_WINDOW }],
    };

    await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

    return NextResponse.json({ success: true, message: "Crush settings applied successfully!", configPath });
  } catch (error) {
    console.log("Error updating crush settings:", error);
    return NextResponse.json({ error: { message: "Failed to update crush settings" } }, { status: 500 });
  }
}

export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const configPath = getCrushConfigPath();
    const existing = await readConfig();
    if (!existing) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    if (existing.providers) {
      delete existing.providers[PROVIDER_ID];
      for (const legacyId of LEGACY_PROVIDER_IDS) delete existing.providers[legacyId];
      if (Object.keys(existing.providers).length === 0) delete existing.providers;
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }

    return NextResponse.json({ success: true, message: "HxRouter removed from Crush" });
  } catch (error) {
    console.log("Error resetting crush settings:", error);
    return NextResponse.json({ error: { message: "Failed to reset crush settings" } }, { status: 500 });
  }
}
