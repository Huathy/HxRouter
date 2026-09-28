"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { probeCliInstalled } from "../_shared/cliConfig.js";
import { parseTOML, stringifyTOML } from "confbox";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

const MANAGED_MARKER = "managed by HxRouter";
// Written before the HxRouter rename; still recognised so an already-configured
// CodeWhale keeps reporting as configured.
const LEGACY_MARKERS = ["managed by 9Router", "managed by 9router"];

const getCodewhaleDir = () => path.join(os.homedir(), ".codewhale");
const getCodewhaleConfigPath = () => path.join(getCodewhaleDir(), "config.toml");

const checkCodewhaleInstalled = () => probeCliInstalled("codewhale", [getCodewhaleConfigPath()]);

const readConfigToml = async () => {
  try {
    return await fs.readFile(getCodewhaleConfigPath(), "utf-8");
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
    const installed = await checkCodewhaleInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "CodeWhale CLI is not installed" });
    }

    const content = await readConfigToml();

    return NextResponse.json({
      installed: true,
      config: parseConfigToml(content),
      hasHxRouter: hasRouterConfig(content),
      // Legacy response alias retained for older clients.
      has9Router: hasRouterConfig(content),
      configPath: getCodewhaleConfigPath(),
    });
  } catch (error) {
    console.log("Error checking codewhale settings:", error);
    return NextResponse.json({ error: { message: "Failed to check codewhale settings" } }, { status: 500 });
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

    const configPath = getCodewhaleConfigPath();
    await fs.mkdir(getCodewhaleDir(), { recursive: true });

    const config = parseConfigToml(await readConfigToml());
    config.openai = {
      base_url: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      api_key: apiKey || "sk_HxRouter",
      model: model || config.openai?.model || "provider/model-id",
    };

    await fs.writeFile(configPath, `# CodeWhale config — ${MANAGED_MARKER}\n\n${stringifyTOML(config)}`, "utf-8");

    return NextResponse.json({ success: true, message: "CodeWhale settings applied successfully!", configPath });
  } catch (error) {
    console.log("Error updating codewhale settings:", error);
    return NextResponse.json({ error: { message: "Failed to update codewhale settings" } }, { status: 500 });
  }
}

export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const configPath = getCodewhaleConfigPath();
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

    return NextResponse.json({ success: true, message: "HxRouter removed from CodeWhale" });
  } catch (error) {
    console.log("Error resetting codewhale settings:", error);
    return NextResponse.json({ error: { message: "Failed to reset codewhale settings" } }, { status: 500 });
  }
}
