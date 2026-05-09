import {
  defaultBaseUrlForProvider,
  parseProvider,
  providerCapability,
  type ApiProvider,
} from "../client/capabilities.js";
import { p } from "../ui/palette.js";
import { pickModel, pickProvider } from "./picker.js";
import type { SlashCommandHandler } from "./types.js";

export const providerCommand: SlashCommandHandler = async ({ cfg, session, parts, runtime, write }) => {
  let rawProvider: string | undefined = parts[1];
  if (!rawProvider) {
    rawProvider = await pickProvider(cfg.provider, runtime.renderPicker, runtime.clearModal) || undefined;
  }
  if (!rawProvider) {
    write(JSON.stringify({
      provider: cfg.provider,
      base_url: cfg.base_url,
      model: cfg.model,
      capability: providerCapability(cfg.provider as ApiProvider, cfg.model),
    }, null, 2));
    return;
  }
  const provider = parseProvider(rawProvider);
  const modelArg = parts[2] || cfg.model;
  const capability = providerCapability(provider, modelArg);
  cfg.provider = provider;
  cfg.base_url = defaultBaseUrlForProvider(provider);
  cfg.model = capability.resolved_model;
  session.model = capability.resolved_model;
  runtime.rebuildRuntime();
  runtime.rebuildSystemPrompt();
  write(p.success(`Provider: ${provider}`));
  write(p.success(`Model: ${capability.resolved_model}`));
  write(p.dim(`Base URL: ${cfg.base_url}`));
};

export const modelCommand: SlashCommandHandler = async ({ cfg, session, parts, runtime, write }) => {
  const model = parts[1];
  if (model) {
    const capability = providerCapability(cfg.provider as ApiProvider, model);
    if (capability.resolved_model) {
      cfg.model = capability.resolved_model;
      session.model = capability.resolved_model;
      runtime.rebuildRuntime();
      write(p.success(`Model: ${capability.resolved_model}`));
      if (capability.deprecation) {
        write(p.warning(`${capability.deprecation.alias} is deprecated; use ${capability.deprecation.replacement}`));
      }
    } else {
      write(p.warning(`Unknown model: ${model}. Available: deepseek-v4-pro, deepseek-v4-flash`));
    }
    return;
  }

  const selected = await pickModel(cfg.model, runtime.renderPicker, runtime.clearModal);
  if (selected) {
    cfg.model = selected;
    session.model = selected;
    runtime.rebuildRuntime();
    write(p.success(`Model: ${selected}`));
  }
};

export const capabilitiesCommand: SlashCommandHandler = ({ cfg, write }) => {
  const capability = providerCapability(cfg.provider as ApiProvider, cfg.model);
  write(JSON.stringify(capability, null, 2));
};

