import { describe, test, expect } from "bun:test";
import {
  stripAnsi,
  formatDuration,
  renderSprintBanner,
  renderStoryProgress,
  renderFixLoop,
  renderSprintSummary,
  renderError,
  renderStoryComplete,
} from "../../src/cli/dashboard";
import { WorkflowType } from "../../src/core/types";
import type { AutoBMADConfig, SprintResult, StoryResult } from "../../src/core/types";
import type { StepDisplay } from "../../src/cli/dashboard";

function captureOutput(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

function makeConfig(overrides?: Partial<AutoBMADConfig>): AutoBMADConfig {
  return {
    projectDir: "/tmp/test-project",
    maxRetries: 3,
    timeout: 300,
    verbose: false,
    ...overrides,
  };
}

function makeSprintResult(
  overrides?: Partial<SprintResult>,
): SprintResult {
  return {
    status: "complete",
    totalStories: 15,
    completed: 12,
    failed: 1,
    skipped: 2,
    results: [],
    durationMs: 5025000,
    ...overrides,
  };
}

function makeStoryResult(
  overrides?: Partial<StoryResult>,
): StoryResult {
  return {
    storyKey: "6-2-add-feature",
    success: true,
    retries: 0,
    durationMs: 150000,
    ...overrides,
  };
}

// ─── stripAnsi ──────────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  test("removes ANSI color codes", () => {
    const colored = "\x1b[1m\x1b[36mHello\x1b[0m World";
    expect(stripAnsi(colored)).toBe("Hello World");
  });

  test("handles text without ANSI codes", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("removes multiple ANSI sequences", () => {
    const input = "\x1b[31mred\x1b[0m \x1b[33myellow\x1b[0m \x1b[1;31mbold-red\x1b[0m";
    expect(stripAnsi(input)).toBe("red yellow bold-red");
  });
});

// ─── formatDuration ─────────────────────────────────────────────────────────────

describe("formatDuration", () => {
  test("0ms → '0s'", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  test("500ms → '0s' (rounds down)", () => {
    expect(formatDuration(500)).toBe("0s");
  });

  test("45000ms → '45s'", () => {
    expect(formatDuration(45000)).toBe("45s");
  });

  test("60000ms → '1m' (exact minute, no seconds)", () => {
    expect(formatDuration(60000)).toBe("1m");
  });

  test("125000ms → '2m 5s'", () => {
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  test("5025000ms → '1h 23m 45s'", () => {
    expect(formatDuration(5025000)).toBe("1h 23m 45s");
  });

  test("3600000ms → '1h' (exact hour)", () => {
    expect(formatDuration(3600000)).toBe("1h");
  });
});

// ─── renderSprintBanner ─────────────────────────────────────────────────────────

describe("renderSprintBanner", () => {
  test("contains box drawing characters", () => {
    const output = captureOutput(() => renderSprintBanner(makeConfig(), 15));
    expect(output).toContain("╔");
    expect(output).toContain("═");
    expect(output).toContain("╗");
    expect(output).toContain("║");
    expect(output).toContain("╚");
    expect(output).toContain("╝");
  });

  test("displays project path", () => {
    const output = captureOutput(() =>
      renderSprintBanner(makeConfig({ projectDir: "/my/project" }), 10),
    );
    expect(output).toContain("/my/project");
  });

  test("displays story count", () => {
    const output = captureOutput(() => renderSprintBanner(makeConfig(), 15));
    expect(output).toContain("15");
    expect(output).toContain("Stories");
  });

  test("displays max retries and timeout", () => {
    const output = captureOutput(() =>
      renderSprintBanner(makeConfig({ maxRetries: 5, timeout: 600 }), 10),
    );
    expect(output).toContain("5");
    expect(output).toContain("600s");
  });

  test("displays title with rocket emoji", () => {
    const output = captureOutput(() => renderSprintBanner(makeConfig(), 1));
    const plain = stripAnsi(output);
    expect(plain).toContain("🚀");
    expect(plain).toContain("AutoBMAD Sprint Runner");
  });
});

// ─── renderStoryProgress ────────────────────────────────────────────────────────

describe("renderStoryProgress", () => {
  const steps: StepDisplay[] = [
    { workflow: WorkflowType.SprintPlanning, status: "completed" },
    { workflow: WorkflowType.CreateStory, status: "completed" },
    { workflow: WorkflowType.DevStory, status: "running" },
    { workflow: WorkflowType.CodeReview, status: "pending" },
  ];

  test("shows correct status icons", () => {
    const output = captureOutput(() =>
      renderStoryProgress("6-2-add-feature", 4, 15, steps),
    );
    expect(output).toContain("✅");
    expect(output).toContain("⏳");
    expect(output).toContain("⬜");
  });

  test("shows story key and progress counter", () => {
    const output = captureOutput(() =>
      renderStoryProgress("6-2-add-feature", 4, 15, steps),
    );
    expect(output).toContain("6-2-add-feature");
    expect(output).toContain("4/15");
  });

  test("shows workflow names with status labels", () => {
    const output = captureOutput(() =>
      renderStoryProgress("test", 1, 1, steps),
    );
    expect(output).toContain("sprint-planning");
    expect(output).toContain("completed");
    expect(output).toContain("running...");
    expect(output).toContain("pending");
  });

  test("handles empty steps array", () => {
    const output = captureOutput(() =>
      renderStoryProgress("test", 1, 1, []),
    );
    expect(output).toContain("Story test");
    expect(output).toContain("1/1");
  });
});

// ─── renderFixLoop ──────────────────────────────────────────────────────────────

describe("renderFixLoop", () => {
  test("shows retry count", () => {
    const output = captureOutput(() =>
      renderFixLoop("6-2-add-feature", 2, 3),
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("retry 2/3");
  });

  test("mentions code-review", () => {
    const output = captureOutput(() => renderFixLoop("test", 1, 5));
    const plain = stripAnsi(output);
    expect(plain).toContain("code-review found issues");
  });

  test("uses warning emoji", () => {
    const output = captureOutput(() => renderFixLoop("test", 1, 3));
    const plain = stripAnsi(output);
    expect(plain).toContain("⚠️");
  });
});

// ─── renderSprintSummary ────────────────────────────────────────────────────────

describe("renderSprintSummary", () => {
  test("contains box drawing characters", () => {
    const output = captureOutput(() =>
      renderSprintSummary(makeSprintResult(), 5025000),
    );
    expect(output).toContain("╔");
    expect(output).toContain("╗");
    expect(output).toContain("╚");
    expect(output).toContain("╝");
  });

  test("shows completed, needs-help, and failed counts", () => {
    const result = makeSprintResult({
      completed: 12,
      failed: 1,
      skipped: 2,
    });
    const output = captureOutput(() => renderSprintSummary(result, 5025000));
    const plain = stripAnsi(output);
    expect(plain).toContain("12");
    expect(plain).toContain("Completed");
    expect(plain).toContain("1");
    expect(plain).toContain("Failed");
    expect(plain).toContain("2");
    expect(plain).toContain("Needs Help");
  });

  test("shows formatted duration", () => {
    const output = captureOutput(() =>
      renderSprintSummary(makeSprintResult(), 5025000),
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("1h 23m 45s");
  });

  test("shows Sprint Complete title", () => {
    const output = captureOutput(() =>
      renderSprintSummary(makeSprintResult(), 1000),
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("📊");
    expect(plain).toContain("Sprint Complete");
  });
});

// ─── renderError ────────────────────────────────────────────────────────────────

describe("renderError", () => {
  test("shows story key and workflow", () => {
    const output = captureOutput(() =>
      renderError(
        "6-2-add-feature",
        WorkflowType.DevStory,
        "Process exited with code 1",
      ),
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("6-2-add-feature");
    expect(plain).toContain("dev-story");
  });

  test("shows error message", () => {
    const output = captureOutput(() =>
      renderError("test", WorkflowType.CodeReview, "Process exited with code 1"),
    );
    expect(output).toContain("Process exited with code 1");
  });

  test("shows resume command", () => {
    const output = captureOutput(() =>
      renderError("test", WorkflowType.DevStory, "error"),
    );
    expect(output).toContain("autobmad resume --dir");
  });

  test("uses error emoji", () => {
    const output = captureOutput(() =>
      renderError("test", WorkflowType.DevStory, "err"),
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("❌");
  });

  test("shows lightbulb hint", () => {
    const output = captureOutput(() =>
      renderError("test", WorkflowType.DevStory, "err"),
    );
    expect(output).toContain("💡");
  });
});

// ─── renderStoryComplete ────────────────────────────────────────────────────────

describe("renderStoryComplete", () => {
  test("shows success with done status", () => {
    const result = makeStoryResult({ success: true, retries: 0, durationMs: 150000 });
    const output = captureOutput(() =>
      renderStoryComplete("6-2-add-feature", result),
    );
    expect(output).toContain("✅");
    expect(output).toContain("6-2-add-feature");
    expect(output).toContain("done");
    expect(output).toContain("0 retries");
    expect(output).toContain("2m 30s");
  });

  test("shows failure with needs-human-intervention status", () => {
    const result = makeStoryResult({
      success: false,
      retries: 3,
      durationMs: 312000,
    });
    const output = captureOutput(() =>
      renderStoryComplete("6-2-add-feature", result),
    );
    expect(output).toContain("⚠️");
    expect(output).toContain("needs-human-intervention");
    expect(output).toContain("3 retries");
    expect(output).toContain("5m 12s");
  });

  test("formats short duration correctly", () => {
    const result = makeStoryResult({ durationMs: 5000 });
    const output = captureOutput(() => renderStoryComplete("test", result));
    expect(output).toContain("5s");
  });
});
