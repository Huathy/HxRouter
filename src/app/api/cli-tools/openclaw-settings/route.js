"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const PROVIDER_NAME = "HxRouter";
const LEGACY_PROVIDER_NAMES = ["VansRoute", "VansRouter", "9router"];
const ROUTER_PROVIDER_NAMES = [PROVIDER_NAME, ...LEGACY_PROVIDER_NAMES];

// OpenClaw 2026.5.x writes agents[].model as either a plain string
// (legacy) or as an object `{ primary, fallbacks }`. Normalize to the
// string id so downstream consumers can call `.startsWith()` safely.
const resolveAgentModel = (m) => {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.primary ?? "";
  return "";
};

const getOpenClawDir = () => path.join(os.homedir(), ".openclaw");
const getOpenClawSettingsPath = () => path.join(getOpenClawDir(), "openclaw.json");

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where openclaw" : "which openclaw";
    // On Windows, inject %APPDATA%\npm into PATH so npm global packages are found
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getOpenClawSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    const settingsPath = getOpenClawSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

const getRouterProvider = (settings) => {
  const providers = settings?.models?.providers || settings?.providers;
  if (!providers) return null;
  const key = ROUTER_PROVIDER_NAMES.find((name) => providers[name]);
  return key ? providers[key] : null;
};

const hasRouterConfig = (settings) => !!getRouterProvider(settings);

const isRouterModel = (model) => {
  const resolved = resolveAgentModel(model);
  return ROUTER_PROVIDER_NAMES.some((name) => resolved.startsWith(`${name}/`));
};

// Read per-agent models.json and return the current model id without its router prefix.
const readAgentModel = async (agentDir) => {
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const content = await fs.readFile(modelsPath, "utf-8");
    const data = JSON.parse(content);
    const models = getRouterProvider(data)?.models;
    return models?.[0]?.id || null;
  } catch {
    return null;
  }
};

// GET - Check openclaw CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenClawInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Open Claw CLI is not installed",
      });
    }

    const settings = await readSettings();

    // Enrich agents list with current per-agent model from models.json.
    // Coerce agent.model to its string id when OpenClaw stores it as
    // `{ primary, fallbacks }` so downstream `.startsWith()` calls work.
    const agentList = settings?.agents?.list || [];
    const enrichedAgents = await Promise.all(
      agentList.map(async (agent) => {
        const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null;
        return { ...agent, model: resolveAgentModel(agent.model), currentModel: agentModel };
      })
    );

    const hasHxRouter = hasRouterConfig(settings);

    return NextResponse.json({
      installed: true,
      settings,
      agents: enrichedAgents,
      hasHxRouter,
      // Legacy response aliases retained for older dashboard/CLI clients.
      has9Router: hasHxRouter,
      hasVansRoute: hasHxRouter,
      settingsPath: getOpenClawSettingsPath(),
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 });
  }
}

// Write per-agent models.json
const writeAgentModels = async (agentDir, model, baseUrl, apiKey) => {
  await fs.mkdir(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, "models.json");
  let existing = {};
  try {
    const content = await fs.readFile(modelsPath, "utf-8");
    existing = JSON.parse(content);
  } catch { /* No existing */ }

  if (!existing.providers) existing.providers = {};
  const existingProvider = getRouterProvider(existing) || {};
  existing.providers[PROVIDER_NAME] = {
    ...existingProvider,
    baseUrl,
    apiKey: apiKey || "your_api_key",
    api: "openai-completions",
    models: [{ id: model, name: model.split("/").pop() || model }],
  };
  for (const legacyName of LEGACY_PROVIDER_NAMES) delete existing.providers[legacyName];
  await fs.writeFile(modelsPath, JSON.stringify(existing, null, 2));
};

// POST - Update HxRouter settings (merge with existing settings)
export async function POST(request) {
  try {
    // agentModels: { [agentId]: modelId } for per-agent override
    const { baseUrl, apiKey, model, agentModels = {} } = await request.json();
    
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();

    await fs.mkdir(openclawDir, { recursive: true });

    let settings = (await readSettings()) || {};

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    if (!settings.agents.defaults.model) settings.agents.defaults.model = {};
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const fullModelId = `${PROVIDER_NAME}/${model}`;

    // Remove canonical and legacy router model entries from the allowlist.
    for (const k of Object.keys(settings.agents.defaults.models)) {
      if (isRouterModel(k)) delete settings.agents.defaults.models[k];
    }

    // Update default model
    settings.agents.defaults.model.primary = fullModelId;

    // Collect all unique models (default + per-agent)
    const allModelIds = new Set([model]);
    Object.values(agentModels).forEach((m) => { if (m) allModelIds.add(m); });

    // Add canonical HxRouter models to the allowlist.
    allModelIds.forEach((m) => {
      settings.agents.defaults.models[`${PROVIDER_NAME}/${m}`] = {};
    });

    // Remove old canonical/legacy router models from each configured agent.
    // The model field may be a plain string or `{ primary, fallbacks }`.
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        if (isRouterModel(agent.model)) {
          const { model: _, ...rest } = agent;
          return rest;
        }
        return agent;
      });
    }

    // Update models.providers.HxRouter and remove every legacy duplicate.
    settings.models.providers[PROVIDER_NAME] = {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || "your_api_key",
      api: "openai-completions",
      models: [...allModelIds].map((m) => ({ id: m, name: m.split("/").pop() || m })),
    };
    for (const legacyName of LEGACY_PROVIDER_NAMES) delete settings.models.providers[legacyName];

    // Set per-agent model in agents.list and write models.json
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        const agentModel = agentModels[agent.id];
        if (agentModel) return { ...agent, model: `${PROVIDER_NAME}/${agentModel}` };
        return agent;
      });

      // Write per-agent models.json for agents with agentDir
      await Promise.all(
        settings.agents.list.map(async (agent) => {
          if (!agent.agentDir) return;
          const agentModel = agentModels[agent.id];
          const modelToWrite = agentModel || model; // fallback to default
          await writeAgentModels(agent.agentDir, modelToWrite, normalizedBaseUrl, apiKey);
        })
      );
    }

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to update openclaw settings" }, { status: 500 });
  }
}

// DELETE - Remove HxRouter settings only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getOpenClawSettingsPath();

    // Read existing settings
    const settings = await readSettings();
    if (!settings) {
      return NextResponse.json({
        success: true,
        message: "No settings file to reset",
      });
    }

    // Remove canonical and legacy HxRouter providers.
    if (settings.models?.providers) {
      for (const name of ROUTER_PROVIDER_NAMES) delete settings.models.providers[name];

      if (Object.keys(settings.models.providers).length === 0) {
        delete settings.models.providers;
      }
    }

    // Remove canonical and legacy router models from the allowlist.
    if (settings.agents?.defaults?.models) {
      const keysToRemove = Object.keys(settings.agents.defaults.models).filter((key) => isRouterModel(key));
      for (const key of keysToRemove) {
        delete settings.agents.defaults.models[key];
      }
      if (Object.keys(settings.agents.defaults.models).length === 0) {
        delete settings.agents.defaults.models;
      }
    }

    // Reset agents.defaults.model.primary if it uses a canonical or legacy router provider
    if (isRouterModel(settings.agents?.defaults?.model?.primary)) {
      delete settings.agents.defaults.model.primary;
    }

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "HxRouter settings removed successfully",
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to reset openclaw settings" }, { status: 500 });
  }
}
