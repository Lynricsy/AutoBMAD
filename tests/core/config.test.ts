import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULT_CONFIG } from "../../src/core/config";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobmad-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns default config values when no args or config file", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);
    expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.verbose).toBe(DEFAULT_CONFIG.verbose);
  });

  test("CLI --dir sets projectDir", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);
    expect(config.projectDir).toBe(tmpDir);
  });

  test("CLI -d short flag sets projectDir", async () => {
    const config = await loadConfig(["bun", "script.ts", "-d", tmpDir]);
    expect(config.projectDir).toBe(tmpDir);
  });

  test("CLI --max-retries overrides default", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--max-retries", "7"]);
    expect(config.maxRetries).toBe(7);
  });

  test("CLI -r short flag sets maxRetries", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "-r", "5"]);
    expect(config.maxRetries).toBe(5);
  });

  test("CLI --timeout overrides default", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--timeout", "30000"]);
    expect(config.timeout).toBe(30000);
  });

  test("CLI -t short flag sets timeout", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "-t", "15000"]);
    expect(config.timeout).toBe(15000);
  });

  test("CLI --verbose enables verbose mode", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--verbose"]);
    expect(config.verbose).toBe(true);
  });

  test("CLI -v short flag enables verbose", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "-v"]);
    expect(config.verbose).toBe(true);
  });

  test("loads config from .autobmad.yaml in projectDir", async () => {
    const yaml = `maxRetries: 5\ntimeout: 120000\nverbose: true\n`;
    writeFileSync(join(tmpDir, ".autobmad.yaml"), yaml);

    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);
    expect(config.maxRetries).toBe(5);
    expect(config.timeout).toBe(120000);
    expect(config.verbose).toBe(true);
  });

  test("loads prompts from config file", async () => {
    const yaml = `prompts:\n  dev-story: "Custom prompt for {{storyKey}}"\n`;
    writeFileSync(join(tmpDir, ".autobmad.yaml"), yaml);

    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);
    expect(config.prompts?.["dev-story"]).toBe("Custom prompt for {{storyKey}}");
  });

  test("CLI args override config file values", async () => {
    const yaml = `maxRetries: 5\ntimeout: 120000\nverbose: true\n`;
    writeFileSync(join(tmpDir, ".autobmad.yaml"), yaml);

    const config = await loadConfig([
      "bun", "script.ts",
      "--dir", tmpDir,
      "--max-retries", "10",
      "--timeout", "999",
    ]);
    expect(config.maxRetries).toBe(10);
    expect(config.timeout).toBe(999);
    expect(config.verbose).toBe(true);
  });

  test("--config flag loads explicit config file", async () => {
    const customConfigPath = join(tmpDir, "custom.yaml");
    const yaml = `maxRetries: 9\ntimeout: 55000\n`;
    writeFileSync(customConfigPath, yaml);

    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--config", customConfigPath]);
    expect(config.maxRetries).toBe(9);
    expect(config.timeout).toBe(55000);
    expect(config.configPath).toBe(customConfigPath);
  });

  test("-c short flag loads explicit config file", async () => {
    const customConfigPath = join(tmpDir, "custom.yaml");
    writeFileSync(customConfigPath, `maxRetries: 2\n`);

    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "-c", customConfigPath]);
    expect(config.maxRetries).toBe(2);
  });

  test("missing optional .autobmad.yaml uses defaults gracefully", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);
    expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.verbose).toBe(false);
  });

  test("throws when explicit --config file does not exist", async () => {
    const nonExistent = join(tmpDir, "does-not-exist.yaml");
    await expect(
      loadConfig(["bun", "script.ts", "--dir", tmpDir, "--config", nonExistent])
    ).rejects.toThrow(`Config file not found: ${nonExistent}`);
  });

  test("throws when projectDir does not exist", async () => {
    const nonExistent = join(tmpDir, "nonexistent-dir");
    await expect(
      loadConfig(["bun", "script.ts", "--dir", nonExistent])
    ).rejects.toThrow(`Project directory does not exist: ${nonExistent}`);
  });

  test("empty YAML config file uses defaults", async () => {
    writeFileSync(join(tmpDir, ".autobmad.yaml"), ``);
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);
    expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
  });

  test("DEFAULT_CONFIG has maxSprints: 10", () => {
    expect(DEFAULT_CONFIG.maxSprints).toBe(10);
  });

  test("CLI --max-sprints sets maxSprints", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--max-sprints", "5"]);
    expect(config.maxSprints).toBe(5);
  });

  test("CLI -s short flag sets maxSprints", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "-s", "3"]);
    expect(config.maxSprints).toBe(3);
  });

  test("loads maxSprints from YAML config file", async () => {
    const yaml = `maxSprints: 7\n`;
    writeFileSync(join(tmpDir, ".autobmad.yaml"), yaml);
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);
    expect(config.maxSprints).toBe(7);
  });

  test("CLI --max-sprints overrides YAML config value", async () => {
    const yaml = `maxSprints: 7\n`;
    writeFileSync(join(tmpDir, ".autobmad.yaml"), yaml);
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--max-sprints", "20"]);
    expect(config.maxSprints).toBe(20);
  });

  test("invalid --max-sprints 0 is ignored (must be >= 1)", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--max-sprints", "0"]);
    expect(config.maxSprints).toBe(DEFAULT_CONFIG.maxSprints);
  });

  test("invalid --max-sprints abc is ignored (NaN check)", async () => {
    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir, "--max-sprints", "abc"]);
    expect(config.maxSprints).toBe(DEFAULT_CONFIG.maxSprints);
  });
});
