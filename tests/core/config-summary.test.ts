import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../../src/core/config.js";

describe("config summary parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobmad-config-summary-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads config with a summary block", async () => {
    writeFileSync(
      join(tmpDir, ".autobmad.yaml"),
      `summary:\n  provider: openai\n  model: gpt-4o-mini\n  interval: 45\n  apiKey: explicit-key\n  openCodeProviderName: my-provider\n`,
    );

    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);

    expect(config.summary).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      interval: 45,
      apiKey: "explicit-key",
      openCodeProviderName: "my-provider",
    });
  });

  test("config without summary leaves summary undefined", async () => {
    writeFileSync(join(tmpDir, ".autobmad.yaml"), "maxRetries: 5\nverbose: true\n");

    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);

    expect(config.summary).toBeUndefined();
  });

  test("ignores summary blocks missing required provider or model", async () => {
    writeFileSync(join(tmpDir, ".autobmad.yaml"), `summary:\n  provider: openai\n`);

    const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);

    expect(config.summary).toBeUndefined();
  });

  test("parses all supported summary providers", async () => {
    for (const provider of ["openai", "anthropic", "google", "openai-compatible"]) {
      writeFileSync(
        join(tmpDir, ".autobmad.yaml"),
        `summary:\n  provider: ${provider}\n  model: test-model\n  baseURL: https://example.com/v1\n`,
      );

      const config = await loadConfig(["bun", "script.ts", "--dir", tmpDir]);

      expect(config.summary?.provider).toBe(provider);
      expect(config.summary?.model).toBe("test-model");
    }
  });
});
