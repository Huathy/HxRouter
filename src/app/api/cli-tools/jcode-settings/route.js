"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

const execAsync = promisify(exec);

const PROVIDER_NAME = "HxRouter";
const LEGACY_PROVIDER_NAMES = ["VansRoute", "VansRouter", "9router", "9Router"];
const ROUTER_PROVIDER_NAMES = [PROVIDER_NAME, ...LEGACY_PROVIDER_NAMES];
const API_KEY_ENV_BY_PROVIDER = Object.fromEntries(
  ROUTER_PROVIDER_NAMES.map((name) => [name, `JCODE_${name}_API_KEY`]),
);

const getJcodeConfigDir = () => path.join(os.homedir(), ".jcode");
const getConfigPath = () => path.join(getJcodeConfigDir(), "config.toml");

const getProviderEnvPath = (providerName = PROVIDER_NAME) => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", `provider-${providerName}.env`);
};

const checkJcodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where jcode" : "which jcode";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getJcodeConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return parseTOML(content);
  } catch (error) {
    return { providers: {} };
  }
};

const hasRouterConfig = (config) => {
  if (!config?.providers) return false;

  if (ROUTER_PROVIDER_NAMES.some((name) => config.providers[name])) return true;

  return Object.values(config.providers).some(
    (provider) => provider?.base_url && provider.base_url.includes("localhost:20128"),
  );
};

const writeConfig = async (config) => {
  const configPath = getConfigPath();
  const content = stringifyTOML(config);
  await fs.writeFile(configPath, content, "utf-8");
};

const readProviderEnv = async (providerName = PROVIDER_NAME) => {
  try {
    const envPath = getProviderEnvPath(providerName);
    const content = await fs.readFile(envPath, "utf-8");
    const env = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        env[key] = value;
      }
    }

    return env;
  } catch {
    return {};
  }
};

const writeProviderEnv = async (env, providerName = PROVIDER_NAME) => {
  const envPath = getProviderEnvPath(providerName);
  let content = "# jcode provider environment variables\n";

  for (const [key, value] of Object.entries(env)) {
    content += `${key}="${value}"\n`;
  }

  await fs.writeFile(envPath, content, "utf-8");
};

const removeProviderEnvKeys = async (providerName) => {
  const envPath = getProviderEnvPath(providerName);
  try {
    await fs.access(envPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const env = await readProviderEnv(providerName);
  delete env[API_KEY_ENV_BY_PROVIDER[providerName]];

  if (Object.keys(env).length === 0) {
    await fs.unlink(envPath).catch(() => {});
    return;
  }

  await writeProviderEnv(env, providerName);
};

export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isInstalled = await checkJcodeInstalled();

  if (!isInstalled) {
    return NextResponse.json({
      installed: false,
      // SECURITY: informational install hint returned to dashboard UI — not executed server-side
      message: "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/v1.0.0/scripts/install.sh | bash",
    });
  }

  const config = await readConfig();
  const hasHxRouter = hasRouterConfig(config);

  return NextResponse.json({
    installed: true,
    config,
    hasHxRouter,
    // Legacy response aliases retained for older dashboard/CLI clients.
    hasVansRoute: hasHxRouter,
    has9Router: hasHxRouter,
    configPath: getConfigPath(),
  });
}

export async function POST(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { baseUrl, apiKey, models } = await request.json();

    if (!baseUrl || !apiKey) {
      return NextResponse.json(
        { error: "baseUrl and apiKey are required" },
        { status: 400 }
      );
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;

    let config = await readConfig();

    if (!config.providers) {
      config.providers = {};
    }

    config.providers[PROVIDER_NAME] = {
      type: "openai-compatible",
      base_url: normalizedBaseUrl,
      auth: "bearer",
      api_key_env: API_KEY_ENV_BY_PROVIDER[PROVIDER_NAME],
      env_file: `provider-${PROVIDER_NAME}.env`,
      default_model: models && models.length > 0 ? models[0] : "cc/claude-opus-4-7",
      requires_api_key: true,
    };
    for (const legacyName of LEGACY_PROVIDER_NAMES) delete config.providers[legacyName];

    const configDir = getJcodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });

    await writeConfig(config);

    const xdgConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const jcodeConfigDir = path.join(xdgConfigDir, "jcode");
    await fs.mkdir(jcodeConfigDir, { recursive: true });

    const env = await readProviderEnv(PROVIDER_NAME);
    env[API_KEY_ENV_BY_PROVIDER[PROVIDER_NAME]] = apiKey;
    await writeProviderEnv(env, PROVIDER_NAME);

    return NextResponse.json({
      success: true,
      message: "jcode configured successfully. Use: jcode --provider-profile HxRouter",
      configPath: getConfigPath(),
    });
  } catch (error) {
    console.error("Error configuring jcode:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const config = await readConfig();

    if (!config.providers) {
      return NextResponse.json({ success: true, message: "No configuration to remove" });
    }

    for (const name of ROUTER_PROVIDER_NAMES) delete config.providers[name];

    await writeConfig(config);

    for (const name of ROUTER_PROVIDER_NAMES) {
      await removeProviderEnvKeys(name);
    }

    return NextResponse.json({
      success: true,
      message: "HxRouter configuration removed from jcode",
    });
  } catch (error) {
    console.error("Error removing jcode configuration:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
