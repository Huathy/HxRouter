"use server";

import { NextResponse } from "next/server";
import { GET as claudeGet } from "../claude-settings/route";
import { GET as codexGet } from "../codex-settings/route";
import { GET as opencodeGet } from "../opencode-settings/route";
import { GET as droidGet } from "../droid-settings/route";
import { GET as openclawGet } from "../openclaw-settings/route";
import { GET as hermesGet } from "../hermes-settings/route";
import { GET as coworkGet } from "../cowork-settings/route";
import { GET as copilotGet } from "../copilot-settings/route";
import { GET as clineGet } from "../cline-settings/route";
import { GET as kiloGet } from "../kilo-settings/route";
import { GET as deepseekTuiGet } from "../deepseek-tui-settings/route";
import { GET as jcodeGet } from "../jcode-settings/route";
import { GET as grokBuildGet } from "../grok-build-settings/route";
import { GET as devinGet } from "../devin-settings/route";

const STATUS_GETTERS = {
  claude: claudeGet,
  codex: codexGet,
  opencode: opencodeGet,
  droid: droidGet,
  openclaw: openclawGet,
  hermes: hermesGet,
  cowork: coworkGet,
  copilot: copilotGet,
  cline: clineGet,
  kilo: kiloGet,
  "deepseek-tui": deepseekTuiGet,
  jcode: jcodeGet,
  "grok-build": grokBuildGet,
  devin: devinGet,
};

// Batch endpoint: gather all CLI tool statuses in one round-trip.
//
// `request` MUST be forwarded to every getter. The per-tool GET handlers all
// open with `requireDashboardAuth(request)`, which dereferences
// `request.headers` — calling them without an argument throws a TypeError that
// the `catch {}` below turns into `null`, silently blanking every tool status.
// Forwarding the real request also means each tool evaluates the caller's
// actual cookies/headers instead of being waved through.
export async function GET(request) {
  const entries = await Promise.all(
    Object.entries(STATUS_GETTERS).map(async ([toolId, getter]) => {
      try {
        const res = await getter(request);
        const data = await res.json();
        return [toolId, data];
      } catch {
        return [toolId, null];
      }
    })
  );
  return NextResponse.json(Object.fromEntries(entries));
}
