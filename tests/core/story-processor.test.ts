import { describe, test, expect } from "bun:test";

import { StoryProcessor } from "../../src/core/story-processor.js";
import {
  AgentType,
  StoryStatus,
  WorkflowType,
  type AutoBMADConfig,
  type ErrorInfo,
  type IRunStateStore,
  type IStateRepository,
  type IWorkflowRunner,
  type RunOptions,
  type RunResult,
  type RunState,
  type SprintStatusData,
} from "../../src/core/types.js";
import { MaxRetriesExceededError, WorkflowHaltError } from "../../src/core/errors.js";
import { Logger, LogLevel } from "../../src/core/logger.js";

class StubLogger extends Logger {
  constructor() {
    super("story-processor-test", {
      level: LogLevel.Debug,
      logDir: "/tmp/autobmad-story-processor-test-logs",
      silent: true,
    });
  }

  debug(_message: string, _data?: Record<string, unknown>): void {}
  info(_message: string, _data?: Record<string, unknown>): void {}
  warn(_message: string, _data?: Record<string, unknown>): void {}
  error(_message: string, _data?: Record<string, unknown>): void {}
  fatal(_message: string, _data?: Record<string, unknown>): void {}
}

function makeSprintStatusData(storyKey: string, status: StoryStatus): SprintStatusData {
  return {
    generated: "2026-02-28",
    project: "Test",
    project_key: "T",
    tracking_system: "file-system",
    story_location: "{project-root}",
    development_status: { [storyKey]: status },
  };
}

function okResult(id: string): RunResult {
  return {
    sessionId: id,
    success: true,
    durationMs: 1,
    messageCount: 1,
    summary: id,
  };
}

function failResult(reason: string): RunResult {
  return {
    sessionId: "ses_fail",
    success: false,
    durationMs: 1,
    messageCount: 1,
    summary: reason,
  };
}

function makeStateRepoSequence(params: {
  storyKey: string;
  statuses: StoryStatus[];
}) {
  let readIdx = 0;
  const updateCalls: Array<{ storyKey: string; status: StoryStatus }> = [];

  const repo: IStateRepository = {
    async readStatus(): Promise<SprintStatusData> {
      if (readIdx >= params.statuses.length) {
        throw new Error(
          `readStatus called too many times (${readIdx + 1} > ${params.statuses.length})`,
        );
      }

      const status = params.statuses[readIdx]!;
      readIdx += 1;
      return makeSprintStatusData(params.storyKey, status);
    },

    async updateStatus(storyKey: string, status: StoryStatus): Promise<void> {
      updateCalls.push({ storyKey, status });
    },

    async getNextStory(): Promise<string | null> {
      return null;
    },

    async getAllStories(): Promise<Map<string, StoryStatus>> {
      return new Map();
    },

    async isSprintComplete(): Promise<boolean> {
      return false;
    },
  };

  return {
    repo,
    updateCalls,
    getReadCount: () => readIdx,
  };
}

function makeRunnerSequence(results: RunResult[]) {
  let runIdx = 0;
  const callHistory: RunOptions[] = [];

  const runner: IWorkflowRunner = {
    async run(options: RunOptions): Promise<RunResult> {
      callHistory.push(structuredClone(options));

      if (runIdx >= results.length) {
        throw new Error(`runner.run called too many times (${runIdx + 1} > ${results.length})`);
      }

      const result = results[runIdx]!;
      runIdx += 1;
      return structuredClone(result);
    },
  };

  return { runner, callHistory, getRunCount: () => runIdx };
}

function makeRunStateStore() {
  const retries: Record<string, number> = {};
  const errors: ErrorInfo[] = [];
  const completedStories: string[] = [];
  let loadCalls = 0;
  let incrementCalls = 0;
  let markCompleteCalls = 0;

  const store: IRunStateStore = {
    async load(): Promise<RunState> {
      loadCalls += 1;
      const now = new Date();
      return {
        currentStory: null,
        retries,
        errors,
        startedAt: now,
        lastUpdatedAt: now,
        completedStories,
      };
    },

    async save(_state: RunState): Promise<void> {},

    getRetryCount(storyKey: string): number {
      return retries[storyKey] ?? 0;
    },

    incrementRetry(storyKey: string): void {
      incrementCalls += 1;
      const current = retries[storyKey] ?? 0;
      retries[storyKey] = current + 1;
    },

    setError(error: ErrorInfo): void {
      errors.push(error);
    },

    clearStory(): void {},

    markComplete(storyKey: string): void {
      markCompleteCalls += 1;
      if (!completedStories.includes(storyKey)) completedStories.push(storyKey);
      delete retries[storyKey];
    },

    async reset(): Promise<void> {},
  };

  return {
    store,
    errors,
    completedStories,
    getLoadCalls: () => loadCalls,
    getIncrementCalls: () => incrementCalls,
    getMarkCompleteCalls: () => markCompleteCalls,
  };
}

describe("StoryProcessor", () => {
  const storyKey = "0-1-test-story";

  function makeConfig(overrides: Partial<AutoBMADConfig> = {}): AutoBMADConfig {
    return {
      projectDir: "/tmp/project",
      maxRetries: 3,
      timeout: 123_000,
      verbose: false,
      ...overrides,
    };
  }

  test("Happy Path: backlog -> create -> dev -> review -> done (0 retries)", async () => {
    const { repo, updateCalls, getReadCount } = makeStateRepoSequence({
      storyKey,
      statuses: [
        StoryStatus.Backlog,
        StoryStatus.ReadyForDev,
        StoryStatus.Review,
        StoryStatus.Done,
      ],
    });

    const { runner, callHistory, getRunCount } = makeRunnerSequence([
      okResult("create"),
      okResult("dev"),
      okResult("review"),
    ]);

    const { store: runState, getIncrementCalls, getMarkCompleteCalls, getLoadCalls } =
      makeRunStateStore();

    const logger = new StubLogger();
    const processor = new StoryProcessor(repo, runner, runState, logger, makeConfig());

    const result = await processor.processStory(storyKey);

    expect(result.storyKey).toBe(storyKey);
    expect(result.success).toBe(true);
    expect(result.retries).toBe(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);

    expect(getLoadCalls()).toBe(1);
    expect(getReadCount()).toBe(4);
    expect(getRunCount()).toBe(3);
    expect(updateCalls).toHaveLength(0);
    expect(getIncrementCalls()).toBe(0);
    expect(getMarkCompleteCalls()).toBe(1);

    expect(callHistory).toHaveLength(3);
    expect(callHistory[0]?.agent).toBe(AgentType.Sisyphus);
    expect(callHistory[1]?.agent).toBe(AgentType.Sisyphus);
    expect(callHistory[2]?.agent).toBe(AgentType.Hephaestus);

    for (const call of callHistory) {
      expect(call.directory).toBe("/tmp/project");
      expect(call.timeout).toBe(123_000);
      expect(call.message).toContain(storyKey);
      expect(call.message).toContain("/tmp/project");
    }

    expect(callHistory[0]?.message).toContain("create-story");
    expect(callHistory[1]?.message).toContain("dev-story");
    expect(callHistory[2]?.message).toContain("code-review");
  });

  test("Fix Loop Success: code-review leaves story not done, retry dev+review, then done", async () => {
    const { repo, updateCalls, getReadCount } = makeStateRepoSequence({
      storyKey,
      statuses: [
        StoryStatus.Backlog,
        StoryStatus.ReadyForDev,
        StoryStatus.Review,
        StoryStatus.InProgress,
        StoryStatus.Review,
        StoryStatus.Done,
      ],
    });

    const { runner, callHistory, getRunCount } = makeRunnerSequence([
      okResult("create"),
      okResult("dev"),
      okResult("review-1"),
      okResult("dev-retry"),
      okResult("review-2"),
    ]);

    const { store: runState, getIncrementCalls, getMarkCompleteCalls } = makeRunStateStore();

    const logger = new StubLogger();
    const processor = new StoryProcessor(repo, runner, runState, logger, makeConfig({ maxRetries: 3 }));

    const result = await processor.processStory(storyKey);

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(getReadCount()).toBe(6);
    expect(getRunCount()).toBe(5);
    expect(updateCalls).toHaveLength(0);
    expect(getIncrementCalls()).toBe(1);
    expect(getMarkCompleteCalls()).toBe(1);

    expect(callHistory.map((c) => c.agent)).toEqual([
      AgentType.Sisyphus,
      AgentType.Sisyphus,
      AgentType.Hephaestus,
      AgentType.Sisyphus,
      AgentType.Hephaestus,
    ]);

    expect(callHistory[0]?.message).toContain("create-story");
    expect(callHistory[1]?.message).toContain("dev-story");
    expect(callHistory[2]?.message).toContain("code-review");
    expect(callHistory[3]?.message).toContain("dev-story");
    expect(callHistory[4]?.message).toContain("code-review");
  });

  test("Max Retries Exceeded: code-review never marks done -> needs-human-intervention + throw", async () => {
    const { repo, updateCalls, getReadCount } = makeStateRepoSequence({
      storyKey,
      statuses: [
        StoryStatus.InProgress,
        StoryStatus.Review,
        StoryStatus.InProgress,
        StoryStatus.Review,
        StoryStatus.InProgress,
        StoryStatus.Review,
        StoryStatus.InProgress,
      ],
    });

    const { runner, callHistory, getRunCount } = makeRunnerSequence([
      okResult("dev-0"),
      okResult("review-0"),
      okResult("dev-1"),
      okResult("review-1"),
      okResult("dev-2"),
      okResult("review-2"),
    ]);

    const { store: runState, getIncrementCalls, getMarkCompleteCalls } = makeRunStateStore();

    const logger = new StubLogger();
    const processor = new StoryProcessor(repo, runner, runState, logger, makeConfig({ maxRetries: 2 }));

    try {
      await processor.processStory(storyKey);
      throw new Error("expected processStory to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      if (err instanceof MaxRetriesExceededError) {
        expect(err.storyKey).toBe(storyKey);
        expect(err.maxRetries).toBe(2);
      }
    }

    expect(getReadCount()).toBe(7);
    expect(getRunCount()).toBe(6);
    expect(getIncrementCalls()).toBe(2);
    expect(getMarkCompleteCalls()).toBe(0);

    expect(updateCalls).toEqual([
      { storyKey, status: StoryStatus.NeedsHumanIntervention },
    ]);

    expect(callHistory.map((c) => c.agent)).toEqual([
      AgentType.Sisyphus,
      AgentType.Hephaestus,
      AgentType.Sisyphus,
      AgentType.Hephaestus,
      AgentType.Sisyphus,
      AgentType.Hephaestus,
    ]);
  });

  test("Workflow Halt: runner success=false throws WorkflowHaltError", async () => {
    const { repo, updateCalls, getReadCount } = makeStateRepoSequence({
      storyKey,
      statuses: [StoryStatus.ReadyForDev],
    });

    const { runner, callHistory, getRunCount } = makeRunnerSequence([
      failResult("boom"),
    ]);

    const { store: runState, errors, getIncrementCalls, getMarkCompleteCalls } = makeRunStateStore();

    const logger = new StubLogger();
    const processor = new StoryProcessor(repo, runner, runState, logger, makeConfig());

    try {
      await processor.processStory(storyKey);
      throw new Error("expected processStory to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowHaltError);
      if (err instanceof WorkflowHaltError) {
        expect(err.storyKey).toBe(storyKey);
        expect(err.workflow).toBe(WorkflowType.DevStory);
        expect(err.reason).toBe("boom");
      }
    }

    expect(getReadCount()).toBe(1);
    expect(getRunCount()).toBe(1);
    expect(updateCalls).toHaveLength(0);
    expect(getIncrementCalls()).toBe(0);
    expect(getMarkCompleteCalls()).toBe(0);

    expect(callHistory).toHaveLength(1);
    expect(callHistory[0]?.agent).toBe(AgentType.Sisyphus);
    expect(callHistory[0]?.message).toContain("dev-story");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "E_WORKFLOW_HALT",
      storyKey,
      workflow: WorkflowType.DevStory,
      message: "boom",
    });
  });

  test("Story already done is handled gracefully (no runner calls)", async () => {
    const { repo, updateCalls, getReadCount } = makeStateRepoSequence({
      storyKey,
      statuses: [StoryStatus.Done],
    });

    const { runner, callHistory, getRunCount } = makeRunnerSequence([]);
    const { store: runState, getMarkCompleteCalls } = makeRunStateStore();

    const logger = new StubLogger();
    const processor = new StoryProcessor(repo, runner, runState, logger, makeConfig());

    const result = await processor.processStory(storyKey);

    expect(result.success).toBe(true);
    expect(result.retries).toBe(0);
    expect(getReadCount()).toBe(1);
    expect(getRunCount()).toBe(0);
    expect(callHistory).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(getMarkCompleteCalls()).toBe(1);
  });
});
