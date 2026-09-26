"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

const PROVIDER_NAME = "HxRouter";
const LEGACY_PROVIDER_NAMES = ["VansRouter", "VansRoute", "9Router"];
const ROUTER_PROVIDER_NAMES = [PROVIDER_NAME, ...LEGACY_PROVIDER_NAMES];

// Resolve chatLanguageModels.json path per OS
const getConfigPath = () => {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA || home, "Code", "User", "chatLanguageModels.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  return path.join(home, ".config", "Code", "User", "chatLanguageModels.json");
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

const hasRouterConfig = (config) => {
  if (!Array.isArray(config)) return false;
  return config.some((entry) => ROUTER_PROVIDER_NAMES.includes(entry.name));
};

const getRouterEntry = (config) => {
  if (!Array.isArray(config)) return null;
  for (const name of ROUTER_PROVIDER_NAMES) {
    const entry = config.find((item) => item.name === name);
    if (entry) return entry;
  }
  return null;
};

// GET - Read current copilot config
export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const config = await readConfig();
    const entry = getRouterEntry(config);
    const hasHxRouter = hasRouterConfig(config);

    return NextResponse.json({
      installed: true,
      config,
      hasHxRouter,
      // Legacy response alias retained for older clients.
      has9Router: hasHxRouter,
      configPath: getConfigPath(),
      currentModel: entry?.models?.[0]?.id || null,
      currentUrl: entry?.models?.[0]?.url || null,
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to check copilot settings" }, { status: 500 });
  }
}

// POST - Apply HxRouter config to chatLanguageModels.json
export async function POST(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { baseUrl, apiKey, models } = await request.json();

    if (!baseUrl || !models?.length) {
      return NextResponse.json({ error: "baseUrl and models are required" }, { status: 400 });
    }

    const configPath = getConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    // Read existing config array
    const parsed = await readConfig();
    let config = Array.isArray(parsed) ? parsed : [];

    const endpointUrl = `${baseUrl}/chat/completions#models.ai.azure.com`;
    const keyToUse = apiKey || "sk_HxRouter";

    const newEntry = {
      name: PROVIDER_NAME,
      vendor: "azure",
      apiKey: keyToUse,
      models: models.map((id) => ({
        id,
        name: id,
        url: endpointUrl,
        toolCalling: true,
        vision: false,
        maxInputTokens: 128000,
        maxOutputTokens: 16000,
      })),
    };

    // Replace canonical or legacy HxRouter entries after migration.
    const idx = config.findIndex((e) => ROUTER_PROVIDER_NAMES.includes(e.name));
    if (idx >= 0) {
      config[idx] = newEntry;
    } else {
      config.push(newEntry);
    }

    // Remove duplicate legacy/canonical entries left by earlier versions.
    const canonicalIndex = config.indexOf(newEntry);
    config = config.filter(
      (entry, index) => !ROUTER_PROVIDER_NAMES.includes(entry.name) || index === canonicalIndex,
    );

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Copilot settings applied! Reload VS Code to take effect.",
      configPath,
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to update copilot settings" }, { status: 500 });
  }
}

// DELETE - Remove HxRouter entry from chatLanguageModels.json
export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const configPath = getConfigPath();

    let config = [];
    const parsed = await readConfig();
    if (!parsed) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    config = Array.isArray(parsed) ? parsed : [];

    config = config.filter((entry) => !ROUTER_PROVIDER_NAMES.includes(entry.name));
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "HxRouter removed from Copilot config",
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to reset copilot settings" }, { status: 500 });
  }
}
