"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { probeCliInstalled, readJsoncFile } from "../_shared/cliConfig.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

const MANAGED_BY = "hxrouter";
// Written before the HxRouter rename; still recognised so an already-configured
// Smelt keeps reporting as configured.
const LEGACY_MANAGED_BY = ["9router", "9Router"];

const getSmeltConfigPath = () => path.join(os.homedir(), ".smelt", "config.json");
const getSmeltDir = () => path.dirname(getSmeltConfigPath());

const checkSmeltInstalled = () => probeCliInstalled("smelt", [getSmeltConfigPath()]);
const readConfig = () => readJsoncFile(getSmeltConfigPath());

const hasRouterConfig = (config) =>
  config?._managedBy === MANAGED_BY
  || LEGACY_MANAGED_BY.includes(config?._managedBy)
  || Boolean(config?.baseUrl?.includes("20128"));

export async function GET(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const installed = await checkSmeltInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "Smelt CLI is not installed" });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasHxRouter: hasRouterConfig(config),
      // Legacy response alias retained for older clients.
      has9Router: hasRouterConfig(config),
      configPath: getSmeltConfigPath(),
    });
  } catch (error) {
    console.log("Error checking smelt settings:", error);
    return NextResponse.json({ error: { message: "Failed to check smelt settings" } }, { status: 500 });
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

    const configPath = getSmeltConfigPath();
    await fs.mkdir(getSmeltDir(), { recursive: true });

    const existing = (await readConfig()) || {};
    const updated = {
      ...existing,
      baseUrl: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      apiKey: apiKey || "sk_HxRouter",
      model: model || existing.model || "provider/model-id",
      _managedBy: MANAGED_BY,
    };

    await fs.writeFile(configPath, JSON.stringify(updated, null, 2), "utf-8");

    return NextResponse.json({ success: true, message: "Smelt settings applied successfully!", configPath });
  } catch (error) {
    console.log("Error updating smelt settings:", error);
    return NextResponse.json({ error: { message: "Failed to update smelt settings" } }, { status: 500 });
  }
}

export async function DELETE(request) {
  if (!await requireDashboardAuth(request)) return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });

  try {
    const configPath = getSmeltConfigPath();
    const existing = await readConfig();
    if (!existing) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    delete existing.baseUrl;
    delete existing.apiKey;
    delete existing.model;
    delete existing._managedBy;

    if (Object.keys(existing).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");
    }

    return NextResponse.json({ success: true, message: "HxRouter removed from Smelt" });
  } catch (error) {
    console.log("Error resetting smelt settings:", error);
    return NextResponse.json({ error: { message: "Failed to reset smelt settings" } }, { status: 500 });
  }
}
