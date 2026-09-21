import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getSettings } from "@/lib/localDb";
import { AI_MODELS } from "@/shared/constants/config";
import { AI_PROVIDERS, getProviderAlias, resolveProviderId } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { fetchModelsFetcherIds } from "@/sse/services/allowedModels.js";
import { fetchKiloFreeModels } from "@/lib/kiloFreeModels";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();
    const settings = await getSettings();
    const disabledProviders = new Set(settings.disabledProviders || []);
    const isProviderDisabled = (providerIdOrAlias) =>
      disabledProviders.has(resolveProviderId(providerIdOrAlias));

    const models = AI_MODELS
      .filter((m) => {
        if (isProviderDisabled(m.provider)) return false;
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    // Kilo Code exposes a dynamic free catalog on top of its 8 hardcoded models.
    // Inject the enabled free models into the same array so the ACL dialog and
    // the combo model picker see the full enabled catalog.
    if (!isProviderDisabled("kilocode")) {
      const providerAlias = getProviderAlias("kilocode") || "kc";
      const disabledKilo = new Set([
        ...(disabled[providerAlias] || []),
        ...(disabled["kilocode"] || []),
      ]);
      try {
        const allFree = await fetchKiloFreeModels();
        for (const m of allFree) {
          if (!m?.id || disabledKilo.has(m.id)) continue;
          const fullModel = `kilocode/${m.id}`;
          if (models.some((x) => x.fullModel === fullModel)) continue;
          models.push({
            provider: providerAlias,
            model: m.id,
            name: m.name || m.id,
            fullModel,
            routedModel: `${providerAlias}/${m.id}`,
            alias: modelAliases[fullModel] || m.id,
            caps: {},
          });
        }
      } catch (error) {
        console.log("Kilo free models injection failed:", error);
      }
    }

    // Include dynamic fetcher models for noAuth/passthrough providers (e.g. opencode)
    // so the ACL dialog can list models for providers whose catalog is not static.
    let extra = [];
    for (const [providerId, providerInfo] of Object.entries(AI_PROVIDERS)) {
      if (!providerInfo?.noAuth || !providerInfo?.modelsFetcher) continue;
      if (isProviderDisabled(providerId)) continue;
      const fetcherIds = await fetchModelsFetcherIds(providerId, providerInfo);
      if (!fetcherIds.length) continue;
      const providerAlias = getProviderAlias(providerId) || providerInfo.alias || providerId;
      for (const modelId of fetcherIds) {
        const fullModel = `${providerId}/${modelId}`;
        if (models.some((m) => m.fullModel === fullModel)) continue;
        extra.push({
          provider: providerAlias,
          model: modelId,
          name: modelId,
          fullModel,
          routedModel: `${providerAlias}/${modelId}`,
          alias: modelId,
          caps: {},
        });
      }
    }

    return NextResponse.json({ models: [...models, ...extra] });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
