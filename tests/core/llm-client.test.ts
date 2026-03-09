import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOpenCodeConfig, resolveOpenCodeCredentials, stripJsonComments } from "../../src/core/llm-client.js";
import type { SummaryConfig } from "../../src/core/types.js";

describe("stripJsonComments", () => {
  test("strips line comments", () => {
    expect(stripJsonComments('{"a": 1} // comment')).toBe('{"a": 1} ');
  });

  test("strips block comments", () => {
    expect(stripJsonComments('{"a": /* comment */ 1}')).toBe('{"a":  1}');
  });

  test("preserves strings containing //", () => {
    const input = '{"url": "https://example.com"}';

    expect(stripJsonComments(input)).toBe(input);
  });

  test("preserves strings containing /* */", () => {
    const input = '{"a": "/* not a comment */"}';

    expect(stripJsonComments(input)).toBe(input);
  });
});

describe("readOpenCodeConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobmad-llm-client-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns {} for nonexistent file", () => {
    expect(readOpenCodeConfig(join(tmpDir, "missing.jsonc"))).toEqual({});
  });

  test("reads and parses valid JSONC", () => {
    const configPath = join(tmpDir, "opencode.jsonc");

    writeFileSync(
      configPath,
      `// provider config\n{\n  "provider": {\n    "custom-openai": {\n      "id": "openai",\n      "options": {\n        "apiKey": "secret",\n        "baseURL": "https://example.com/v1"\n      }\n    }\n  }\n}`,
    );

    expect(readOpenCodeConfig(configPath)).toEqual({
      provider: {
        "custom-openai": {
          id: "openai",
          options: {
            apiKey: "secret",
            baseURL: "https://example.com/v1",
          },
        },
      },
    });
  });

  test("returns {} when JSONC parsing fails", () => {
    const configPath = join(tmpDir, "broken.jsonc");

    writeFileSync(configPath, '{"provider":');

    expect(readOpenCodeConfig(configPath)).toEqual({});
  });
});

describe("resolveOpenCodeCredentials", () => {
  const openAIConfig: SummaryConfig = {
    provider: "openai",
    model: "gpt-4o-mini",
  };

  test("finds credentials by openCodeProviderName", () => {
    const config: SummaryConfig = {
      ...openAIConfig,
      openCodeProviderName: "my-provider",
    };

    const openCodeConfig = {
      provider: {
        "my-provider": {
          options: {
            apiKey: "named-key",
            baseURL: "https://named.example.com",
          },
        },
      },
    };

    expect(resolveOpenCodeCredentials(config, openCodeConfig)).toEqual({
      apiKey: "named-key",
      baseURL: "https://named.example.com",
    });
  });

  test("finds credentials by matching entry.id", () => {
    const config: SummaryConfig = {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };

    const openCodeConfig = {
      provider: {
        claude: {
          id: "anthropic",
          options: {
            apiKey: "anthropic-key",
          },
        },
      },
    };

    expect(resolveOpenCodeCredentials(config, openCodeConfig)).toEqual({
      apiKey: "anthropic-key",
    });
  });

  test("finds credentials by matching provider npm package", () => {
    const config: SummaryConfig = {
      provider: "google",
      model: "gemini-2.0-flash",
    };

    const openCodeConfig = {
      provider: {
        gemini: {
          npm: "@ai-sdk/google",
          options: {
            apiKey: "google-key",
          },
        },
      },
    };

    expect(resolveOpenCodeCredentials(config, openCodeConfig)).toEqual({
      apiKey: "google-key",
    });
  });

  test("returns {} when no credentials match", () => {
    const openCodeConfig = {
      provider: {
        other: {
          id: "anthropic",
          options: {
            apiKey: "anthropic-key",
          },
        },
      },
    };

    expect(resolveOpenCodeCredentials(openAIConfig, openCodeConfig)).toEqual({});
  });
});
