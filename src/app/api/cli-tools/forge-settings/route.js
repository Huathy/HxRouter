import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { probeCliInstalled } from "../_shared/cliConfig.js";
import { parseTOML, stringifyTOML } from "confbox";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

const MANAGED_MARKER = "managed by HxRouter";
// Written before the HxRouter rename; still recognised so an already-configured
// ForgeCode keeps reporting as configured.
const LEGACY_MARKERS = ["managed by 9Router", "managed by 9router"];

const getForgeDir = () => path.join(os.homedir(), ".forge");
const getForgeConfigPath = () => path.join(getForgeDir(), "config.toml");

const checkForgeInstalled = () => probeCliInstalled("forge", [getForgeConfigPath()]);

const readConfigToml = async () => {
  try {
    return await fs.readFile(getForgeConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const parseConfigToml = (content) => {
  if (!content) return {};
  try {
    return parseTOML(content);
  } catch {
    return {};
  }
};

const hasRouterConfig = (content) => Boolean(content) && (
  content.includes(MANAGED_MARKER)
  || LEGACY_MARKERS.some((marker) => content.includes(marker))
  || content.includes("localhost:20128")
);

export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const installed = await checkForgeInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "ForgeCode CLI is not installed" });
    }

    const content = await readConfigToml();

    return NextResponse.json({
      installed: true,
      config: parseConfigToml(content),
      hasHxRouter: hasRouterConfig(content),
      // Legacy response alias retained for older clients.
      has9Router: hasRouterConfig(content),
      configPath: getForgeConfigPath(),
    });
  } catch (error) {
    console.log("Error checking forge settings:", error);
    return NextResponse.json({ error: { message: "Failed to check forge settings" } }, { status: 500 });
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

    const configPath = getForgeConfigPath();
    await fs.mkdir(getForgeDir(), { recursive: true });

    const config = parseConfigToml(await readConfigToml());
    config.openai = {
      api_key: apiKey || "sk_HxRouter",
      base_url: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      model: model || "provider/model-id",
    };

    await fs.writeFile(configPath, `# Forge config — ${MANAGED_MARKER}\n\n${stringifyTOML(config)}`, "utf-8");

    return NextResponse.json({ success: true, message: "ForgeCode settings applied successfully!", configPath });
  } catch (error) {
    console.log("Error updating forge settings:", error);
    return NextResponse.json({ error: { message: "Failed to update forge settings" } }, { status: 500 });
  }
}

export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const configPath = getForgeConfigPath();
    const content = await readConfigToml();
    if (!content) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    const config = parseConfigToml(content);
    delete config.openai;

    if (Object.keys(config).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await fs.writeFile(configPath, stringifyTOML(config), "utf-8");
    }

    return NextResponse.json({ success: true, message: "HxRouter removed from ForgeCode" });
  } catch (error) {
    console.log("Error resetting forge settings:", error);
    return NextResponse.json({ error: { message: "Failed to reset forge settings" } }, { status: 500 });
  }
}
