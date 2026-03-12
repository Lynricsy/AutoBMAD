import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { existsSync } from "node:fs";
import type { AutoBMADConfig, SummaryConfig } from "./types.js";
import { resolveSmallModel } from "./llm-client.js";
import { createLogger } from "./logger.js";

const log = createLogger("config");

export const DEFAULT_CONFIG: AutoBMADConfig = {
  projectDir: process.cwd(),
  maxRetries: 3,
  timeout: 18_000_000, // 5 hours
  verbose: false,
  maxSprints: 10,
};

interface ConfigFile {
  maxRetries?: number;
  timeout?: number;
  verbose?: boolean;
  prompts?: Record<string, string>;
  maxSprints?: number;
  summary?: boolean | {
    provider?: string;
    model?: string;
    interval?: number;
    apiKey?: string;
    baseURL?: string;
    openCodeProviderName?: string;
  };
}

/**
 * Parse CLI arguments using node:util parseArgs.
 * Returns only the values that were explicitly provided.
 */
function parseCliArgs(argv: string[]): Partial<AutoBMADConfig> & { configPath?: string } {
  const { values } = parseArgs({
    args: argv.slice(2), // strip node/bun + script path
    options: {
      dir: { type: "string", short: "d" },
      "max-retries": { type: "string", short: "r" },
      timeout: { type: "string", short: "t" },
      config: { type: "string", short: "c" },
      verbose: { type: "boolean", short: "v" },
      "max-sprints": { type: "string", short: "s" },
    },
    strict: false,
  });

  const result: Partial<AutoBMADConfig> & { configPath?: string } = {};

  if (values["dir"] !== undefined) {
    result.projectDir = values["dir"] as string;
  }
  if (values["max-retries"] !== undefined) {
    const parsed = parseInt(values["max-retries"] as string, 10);
    if (!isNaN(parsed)) result.maxRetries = parsed;
  }
  if (values["timeout"] !== undefined) {
    const parsed = parseInt(values["timeout"] as string, 10);
    if (!isNaN(parsed)) result.timeout = parsed;
  }
  if (values["max-sprints"] !== undefined) {
    const parsed = parseInt(values["max-sprints"] as string, 10);
    if (!isNaN(parsed) && parsed >= 1) result.maxSprints = parsed;
  }
  if (values["config"] !== undefined) {
    result.configPath = values["config"] as string;
  }
  if (values["verbose"] !== undefined) {
    result.verbose = values["verbose"] as boolean;
  }

  return result;
}

/**
 * Load and parse a YAML config file, returning only the fields present.
 */
async function loadYamlConfig(path: string): Promise<Partial<AutoBMADConfig>> {
  const file = Bun.file(path);
  const text = await file.text();
  const raw = parseYaml(text) as ConfigFile | null;

  if (!raw || typeof raw !== "object") return {};

  const result: Partial<AutoBMADConfig> = {};

  if (typeof raw.maxRetries === "number") result.maxRetries = raw.maxRetries;
  if (typeof raw.timeout === "number") result.timeout = raw.timeout;
  if (typeof raw.verbose === "boolean") result.verbose = raw.verbose;
  if (raw.prompts && typeof raw.prompts === "object") result.prompts = raw.prompts;
  if (typeof raw.maxSprints === "number") result.maxSprints = raw.maxSprints;

  if (raw.summary === false) {
    result.summary = null;
  } else if (raw.summary === true) {
    const autoConfig = resolveSmallModel();
    if (autoConfig) {
      result.summary = autoConfig;
    }
  } else if (raw.summary && typeof raw.summary === "object") {
    const s = raw.summary;
    if (typeof s.provider === "string" && typeof s.model === "string") {
      const summary: SummaryConfig = {
        provider: s.provider,
        model: s.model,
        ...(typeof s.interval === "number" ? { interval: s.interval } : {}),
        ...(typeof s.apiKey === "string" ? { apiKey: s.apiKey } : {}),
        ...(typeof s.baseURL === "string" ? { baseURL: s.baseURL } : {}),
        ...(typeof s.openCodeProviderName === "string" ? { openCodeProviderName: s.openCodeProviderName } : {}),
      };
      result.summary = summary;
    } else {
      result.summary = null;
    }
  }

  return result;
}

/**
 * Load the final merged configuration.
 * Priority: CLI args > config file > defaults
 *
 * @param argv - Process arguments array (defaults to process.argv)
 */
export async function loadConfig(argv?: string[]): Promise<AutoBMADConfig> {
  const args = argv ?? process.argv;
  const cliArgs = parseCliArgs(args);

  // Resolve config file path:
  // 1. Explicit --config flag
  // 2. .autobmad.yaml in projectDir (using CLI-provided or default dir)
  const projectDir = cliArgs.projectDir ?? DEFAULT_CONFIG.projectDir;
  let fileConfig: Partial<AutoBMADConfig> = {};

  const configFilePath = cliArgs.configPath ?? `${projectDir}/.autobmad.yaml`;

  if (cliArgs.configPath) {
    // Explicit config path — must exist
    const exists = await Bun.file(configFilePath).exists();
    if (!exists) {
      throw new Error(`Config file not found: ${configFilePath}`);
    }
    fileConfig = await loadYamlConfig(configFilePath);
  } else {
    // Optional auto-discovery — silently ignore if absent
    const exists = await Bun.file(configFilePath).exists();
    if (exists) {
      fileConfig = await loadYamlConfig(configFilePath);
    }
  }

  // Merge: defaults < file config < CLI args
  const merged: AutoBMADConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...cliArgs,
    // Always carry configPath from CLI (may be undefined)
    configPath: cliArgs.configPath,
  };

  if (merged.summary === undefined) {
    log.debug("Summary not configured, attempting auto-detection via OpenCode small_model");
    const autoConfig = resolveSmallModel();
    if (autoConfig) {
      log.debug("Auto-detected summary config", { provider: autoConfig.provider, model: autoConfig.model, hasApiKey: !!autoConfig.apiKey, hasBaseURL: !!autoConfig.baseURL });
      merged.summary = autoConfig;
    } else {
      log.debug("Auto-detection returned null — no small_model found or provider unrecognized");
    }
  }

  // Validate: projectDir must exist
  if (!existsSync(merged.projectDir)) {
    throw new Error(`Project directory does not exist: ${merged.projectDir}`);
  }

  return merged;
}
