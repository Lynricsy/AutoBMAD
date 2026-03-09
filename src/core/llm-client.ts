import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { SummaryConfig } from "./types.js";

type LanguageModelV1 = ReturnType<ReturnType<typeof createOpenAI>>;

interface OpenCodeProviderEntry {
  id?: string;
  npm?: string;
  options?: {
    apiKey?: string;
    baseURL?: string;
  };
}

interface OpenCodeConfig {
  provider?: Record<string, OpenCodeProviderEntry>;
}

function extractCredentials(entry: OpenCodeProviderEntry | undefined): {
  apiKey?: string;
  baseURL?: string;
} {
  if (!entry) {
    return {};
  }

  return {
    ...(typeof entry.options?.apiKey === "string" ? { apiKey: entry.options.apiKey } : {}),
    ...(typeof entry.options?.baseURL === "string" ? { baseURL: entry.options.baseURL } : {}),
  };
}

function inferProviderId(entry: OpenCodeProviderEntry): string | undefined {
  if (typeof entry.id === "string") {
    return entry.id;
  }

  if (typeof entry.npm !== "string") {
    return undefined;
  }

  const providerMap: Record<string, SummaryConfig["provider"]> = {
    "@ai-sdk/openai": "openai",
    "@ai-sdk/openai-compatible": "openai-compatible",
    "@ai-sdk/anthropic": "anthropic",
    "@ai-sdk/google": "google",
  };

  return providerMap[entry.npm];
}

export function stripJsonComments(text: string): string {
  const jsoncPattern = /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;

  return text.replace(jsoncPattern, (match) => {
    if (match.startsWith('"')) {
      return match;
    }

    return "";
  });
}

export function readOpenCodeConfig(configPath?: string): object {
  const targetPath = configPath ?? path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");

  try {
    const raw = readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

export function resolveOpenCodeCredentials(
  config: SummaryConfig,
  openCodeConfig: any,
): { apiKey?: string; baseURL?: string } {
  const providers =
    openCodeConfig && typeof openCodeConfig === "object" && !Array.isArray(openCodeConfig)
      ? (openCodeConfig as OpenCodeConfig).provider
      : undefined;

  if (!providers || typeof providers !== "object") {
    return {};
  }

  if (config.openCodeProviderName) {
    const namedEntry = providers[config.openCodeProviderName];

    if (namedEntry && typeof namedEntry === "object") {
      return extractCredentials(namedEntry);
    }

    return {};
  }

  for (const entry of Object.values(providers)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (entry.id === config.provider || inferProviderId(entry) === config.provider) {
      return extractCredentials(entry);
    }
  }

  return {};
}

export function createProvider(config: SummaryConfig, openCodeConfig?: any): LanguageModelV1 {
  const resolvedOpenCodeConfig = openCodeConfig ?? readOpenCodeConfig();
  const resolvedCredentials = resolveOpenCodeCredentials(config, resolvedOpenCodeConfig);
  const apiKey = config.apiKey ?? resolvedCredentials.apiKey;
  const baseURL = config.baseURL ?? resolvedCredentials.baseURL;

  switch (config.provider) {
    case "openai":
      return createOpenAI({ apiKey, baseURL })(config.model);
    case "openai-compatible": {
      if (!baseURL) {
        throw new Error("openai-compatible provider requires baseURL");
      }

      return createOpenAICompatible({ name: "custom", apiKey, baseURL })(config.model);
    }
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(config.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL })(config.model);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

/**
 * 从 OpenCode 的 small_model 字段自动解析 SummaryConfig。
 * small_model 格式: "ProviderName/modelId" (如 "Google/gemini-3-flash-preview")
 * 自动查找 provider 段获取 AI SDK 类型和凭据。
 */
export function resolveSmallModel(openCodeConfig?: any): SummaryConfig | null {
  const config = openCodeConfig ?? readOpenCodeConfig();

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }

  const smallModel = (config as Record<string, unknown>).small_model;

  if (typeof smallModel !== "string") {
    return null;
  }

  const slashIdx = smallModel.indexOf("/");

  if (slashIdx <= 0 || slashIdx === smallModel.length - 1) {
    return null;
  }

  const providerName = smallModel.substring(0, slashIdx);
  const modelId = smallModel.substring(slashIdx + 1);

  const providers = (config as OpenCodeConfig).provider;

  if (!providers || typeof providers !== "object") {
    return null;
  }

  const entry = providers[providerName];

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const providerId = inferProviderId(entry);

  if (!providerId) {
    return null;
  }

  const creds = extractCredentials(entry);

  return {
    provider: providerId,
    model: modelId,
    ...creds,
    openCodeProviderName: providerName,
  };
}

export class LLMClient {
  private readonly config: SummaryConfig;
  private provider: LanguageModelV1 | null = null;

  constructor(config: SummaryConfig) {
    this.config = config;
  }

  initialize(): void {
    this.provider = createProvider(this.config);
  }

  async generateSummary(events: string[], gitDiff: string): Promise<string> {
    if (!this.provider) {
      throw new Error("LLMClient has not been initialized");
    }

    const systemPrompt =
      "You are a development activity summarizer. Given agent events and git diff output, provide a concise 2-3 sentence summary of what the agent is currently doing. Focus on the high-level task, not low-level details.";
    const prompt = [
      "Agent events:",
      events.length > 0 ? events.map((event) => `- ${event}`).join("\n") : "(none)",
      "",
      "Git diff:",
      gitDiff.trim() || "(no git diff)",
    ].join("\n");

    try {
      const result = await generateText({
        model: this.provider,
        system: systemPrompt,
        prompt,
      });

      return result.text;
    } catch (error) {
      throw error;
    }
  }
}
