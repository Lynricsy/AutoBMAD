import { describe, test, expect, afterEach, mock } from "bun:test";

import { ActivitySummarizer, getGitDiff, truncate } from "../../src/core/activity-summarizer.js";
import type { SummaryConfig } from "../../src/core/types.js";

const summaryConfig: SummaryConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
};

const activeSummarizers: ActivitySummarizer[] = [];

function trackSummarizer(summarizer: ActivitySummarizer): ActivitySummarizer {
  activeSummarizers.push(summarizer);
  return summarizer;
}

afterEach(() => {
  for (const summarizer of activeSummarizers) {
    summarizer.stop();
  }
  activeSummarizers.length = 0;
  mock.restore();
});

describe("getGitDiff", () => {
  test("returns a string for a valid directory", async () => {
    const diff = await getGitDiff(process.cwd());

    expect(typeof diff).toBe("string");
  });

  test("returns empty string for an invalid directory", async () => {
    const diff = await getGitDiff("/path/that/does/not/exist");

    expect(diff).toBe("");
  });
});

describe("truncate", () => {
  test("returns the original text when truncation is not needed", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  test("truncates and keeps the last maxChars characters", () => {
    const result = truncate("abcdefghij", 5);

    expect(result).toContain("[...truncated...]");
    expect(result.endsWith("fghij")).toBe(true);
  });
});

describe("ActivitySummarizer", () => {
  test("start initializes the LLM client and stop clears the timer", async () => {
    const llmClient = {
      initialize: mock(() => {}),
      generateSummary: mock(async () => "unused"),
    };
    const streamReader = {
      feed: mock(() => {}),
      drain: mock(() => [] as string[]),
    };

    const summarizer = trackSummarizer(
      new ActivitySummarizer({
        summaryConfig,
        projectDir: process.cwd(),
        renderFn: () => {},
        intervalMs: 100,
        llmClient: llmClient as any,
        streamReader: streamReader as any,
        gitDiffFn: async () => "",
      }),
    );

    await summarizer.start();

    expect(llmClient.initialize.mock.calls).toHaveLength(1);
    expect((summarizer as any).timer).not.toBeNull();

    summarizer.stop();

    expect((summarizer as any).timer).toBeNull();
    expect((summarizer as any).stopped).toBe(true);
  });

  test("handleStderrChunk forwards data to the stream reader", () => {
    const streamReader = {
      feed: mock(() => {}),
      drain: mock(() => [] as string[]),
    };

    const summarizer = new ActivitySummarizer({
      summaryConfig,
      projectDir: process.cwd(),
      renderFn: () => {},
      llmClient: {
        initialize: mock(() => {}),
        generateSummary: mock(async () => "unused"),
      } as any,
      streamReader: streamReader as any,
      gitDiffFn: async () => "",
    });

    summarizer.handleStderrChunk("test\n");

    expect(streamReader.feed.mock.calls).toEqual([["test\n"]]);
  });

  test("runSummary renders a summary when events are available", async () => {
    const renderFn = mock(() => {});
    const llmClient = {
      initialize: mock(() => {}),
      generateSummary: mock(async () => "rendered summary"),
    };
    const streamReader = {
      feed: mock(() => {}),
      drain: mock(() => ["event-1", "event-2"]),
    };
    const gitDiffFn = mock(async () => "git diff");

    const summarizer = trackSummarizer(
      new ActivitySummarizer({
        summaryConfig,
        projectDir: "/tmp/project",
        renderFn,
        llmClient: llmClient as any,
        streamReader: streamReader as any,
        gitDiffFn,
      }),
    );

    await (summarizer as any).runSummary();

    expect(gitDiffFn.mock.calls).toEqual([["/tmp/project"]]);
    expect(llmClient.generateSummary.mock.calls).toEqual([[["event-1\nevent-2"], "git diff"]]);
    expect(renderFn.mock.calls).toEqual([["rendered summary"]]);
  });

  test("runSummary skips git diff and LLM calls when there are no events", async () => {
    const renderFn = mock(() => {});
    const llmClient = {
      initialize: mock(() => {}),
      generateSummary: mock(async () => "unused"),
    };
    const streamReader = {
      feed: mock(() => {}),
      drain: mock(() => [] as string[]),
    };
    const gitDiffFn = mock(async () => "git diff");

    const summarizer = trackSummarizer(
      new ActivitySummarizer({
        summaryConfig,
        projectDir: process.cwd(),
        renderFn,
        llmClient: llmClient as any,
        streamReader: streamReader as any,
        gitDiffFn,
      }),
    );

    await (summarizer as any).runSummary();

    expect(gitDiffFn.mock.calls).toHaveLength(0);
    expect(llmClient.generateSummary.mock.calls).toHaveLength(0);
    expect(renderFn.mock.calls).toHaveLength(0);
  });

  test("stop prevents further scheduling", async () => {
    const renderFn = mock(() => {});
    const llmClient = {
      initialize: mock(() => {}),
      generateSummary: mock(async () => "summary"),
    };
    const streamReader = {
      feed: mock(() => {}),
      drain: mock(() => ["event"]),
    };

    const summarizer = trackSummarizer(
      new ActivitySummarizer({
        summaryConfig,
        projectDir: process.cwd(),
        renderFn,
        intervalMs: 10,
        llmClient: llmClient as any,
        streamReader: streamReader as any,
        gitDiffFn: async () => "git diff",
      }),
    );

    await summarizer.start();
    await Bun.sleep(35);

    summarizer.stop();
    const callCountAfterStop = llmClient.generateSummary.mock.calls.length;

    await Bun.sleep(35);

    expect(callCountAfterStop).toBeGreaterThan(0);
    expect(llmClient.generateSummary.mock.calls).toHaveLength(callCountAfterStop);
  });

  test("LLM failures are silenced", async () => {
    const renderFn = mock(() => {});
    const llmClient = {
      initialize: mock(() => {}),
      generateSummary: mock(async () => {
        throw new Error("llm boom");
      }),
    };
    const streamReader = {
      feed: mock(() => {}),
      drain: mock(() => ["event"]),
    };

    const summarizer = trackSummarizer(
      new ActivitySummarizer({
        summaryConfig,
        projectDir: process.cwd(),
        renderFn,
        llmClient: llmClient as any,
        streamReader: streamReader as any,
        gitDiffFn: async () => "git diff",
      }),
    );

    await expect((summarizer as any).runSummary()).resolves.toBeUndefined();

    expect(renderFn.mock.calls).toHaveLength(0);
    expect((summarizer as any).isSummarizing).toBe(false);
  });
});
