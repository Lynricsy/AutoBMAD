import { describe, test, expect } from "bun:test";

import { SprintOrchestrator } from "../../src/core/sprint-orchestrator.js";
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
import { Logger, LogLevel } from "../../src/core/logger.js";

class StubLogger extends Logger {
  readonly infos: Array<{ message: string; data?: Record<string, unknown> }> = [];
  readonly warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
  readonly errors: Array<{ message: string; data?: Record<string, unknown> }> = [];

  constructor() {
    super("sprint-orchestrator-test", {
      level: LogLevel.Debug,
      logDir: "/tmp/autobmad-sprint-orchestrator-test-logs",
      silent: true,
    });
  }

  debug(_message: string, _data?: Record<string, unknown>): void {}

  info(message: string, data?: Record<string, unknown>): void {
    this.infos.push({ message, data });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.warns.push({ message, data });
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.errors.push({ message, data });
  }

  fatal(_message: string, _data?: Record<string, unknown>): void {}
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

function makeConfig(overrides: Partial<AutoBMADConfig> = {}): AutoBMADConfig {
  return {
    projectDir: "/tmp/project",
    maxRetries: 1,
    timeout: 123_000,
    verbose: false,
    ...overrides,
  };
}

function makeSprintStatusData(statuses: Map<string, StoryStatus>): SprintStatusData {
  const development_status: Record<string, string> = {};
  for (const [key, status] of statuses) {
    development_status[key] = status;
  }

  return {
    generated: "2026-02-28",
    project: "Test",
    project_key: "T",
    tracking_system: "file-system",
    story_location: "{project-root}",
    development_status,
  };
}

function makeInMemoryStateRepo(initial: Array<{ storyKey: string; status: StoryStatus }>) {
  const statuses = new Map<string, StoryStatus>(initial.map((s) => [s.storyKey, s.status]));
  const updateCalls: Array<{ storyKey: string; status: StoryStatus }> = [];

  const repo: IStateRepository = {
    async readStatus(): Promise<SprintStatusData> {
      return makeSprintStatusData(statuses);
    },

    async updateStatus(storyKey: string, status: StoryStatus): Promise<void> {
      updateCalls.push({ storyKey, status });
      statuses.set(storyKey, status);
    },

    async getNextStory(): Promise<string | null> {
      const priority: StoryStatus[] = [
        StoryStatus.InProgress,
        StoryStatus.Review,
        StoryStatus.ReadyForDev,
        StoryStatus.Backlog,
      ];

      for (const wanted of priority) {
        for (const [key, st] of statuses) {
          if (st === wanted) return key;
        }
      }

      return null;
    },

    async getAllStories(): Promise<Map<string, StoryStatus>> {
      return new Map(statuses);
    },

    async isSprintComplete(): Promise<boolean> {
      // 约定：需要人工介入的故事在编排层视为“终态”，不会阻塞 Sprint 结束。
      for (const st of statuses.values()) {
        if (st === StoryStatus.Done) continue;
        if (st === StoryStatus.NeedsHumanIntervention) continue;
        return false;
      }
      return true;
    },
  };

  const setStatus = (storyKey: string, status: StoryStatus): void => {
    statuses.set(storyKey, status);
  };

  return {
    repo,
    setStatus,
    getStatus: (storyKey: string) => statuses.get(storyKey),
    updateCalls,
  };
}

function makeRunStateStore(initial?: Partial<RunState>) {
  const now = new Date();
  let state: RunState = {
    currentStory: null,
    retries: {},
    errors: [],
    startedAt: now,
    lastUpdatedAt: now,
    completedStories: [],
    completedWorkflows: {},
    currentSprint: 1,
    ...initial,
  };

  const saveCalls: RunState[] = [];

  const store: IRunStateStore = {
    async load(): Promise<RunState> {
      return structuredClone(state);
    },

    async save(next: RunState): Promise<void> {
      state = structuredClone(next);
      saveCalls.push(structuredClone(state));
    },

    getRetryCount(storyKey: string): number {
      return state.retries[storyKey] ?? 0;
    },

    incrementRetry(storyKey: string): void {
      const current = state.retries[storyKey] ?? 0;
      state.retries[storyKey] = current + 1;
    },

    recordWorkflow(storyKey: string, workflow: WorkflowType): void {
      const completed = state.completedWorkflows[storyKey] ?? [];
      if (!completed.includes(workflow)) {
        state.completedWorkflows[storyKey] = [...completed, workflow];
      }
    },

    getCompletedWorkflows(storyKey: string): WorkflowType[] {
      return [...(state.completedWorkflows[storyKey] ?? [])];
    },

    hasCompletedWorkflow(storyKey: string, workflow: WorkflowType): boolean {
      return (state.completedWorkflows[storyKey] ?? []).includes(workflow);
    },

    setError(error: ErrorInfo): void {
      state.errors.push(error);
    },

    clearStory(): void {
      state.currentStory = null;
    },

    markComplete(storyKey: string): void {
      if (!state.completedStories.includes(storyKey)) {
        state.completedStories.push(storyKey);
      }
      delete state.retries[storyKey];
      state.currentStory = null;
    },

    setCurrentSprint(sprint: number): void {
      state.currentSprint = sprint;
    },

    async reset(): Promise<void> {
      const now2 = new Date();
      state = {
        currentStory: null,
        retries: {},
        errors: [],
        startedAt: now2,
        lastUpdatedAt: now2,
        completedStories: [],
        completedWorkflows: {},
        currentSprint: 1,
      };
    },
  };

  return {
    store,
    getState: () => state,
    saveCalls,
  };
}

type RunnerOutcome = {
  result: RunResult;
  nextStatus?: StoryStatus;
};

type RunnerBehavior = (params: {
  storyKey: string;
  workflow: "create-story" | "dev-story" | "code-review";
  call: RunOptions;
}) => RunnerOutcome;

function makeDynamicRunner(params: {
  storyKeys: string[];
  setStatus: (storyKey: string, status: StoryStatus) => void;
  behavior?: RunnerBehavior;
}) {
  const callHistory: RunOptions[] = [];

  function detectWorkflow(message: string) {
    if (message.includes("create-story")) return "create-story" as const;
    if (message.includes("dev-story")) return "dev-story" as const;
    if (message.includes("code-review")) return "code-review" as const;
    return null;
  }

  const runner: IWorkflowRunner = {
    async run(options: RunOptions): Promise<RunResult> {
      callHistory.push(structuredClone(options));

      const workflow = detectWorkflow(options.message);
      if (!workflow) {
        return okResult("noop");
      }

      const storyKey = params.storyKeys.find((k) => options.message.includes(k));
      if (!storyKey) {
        throw new Error("runner could not detect storyKey from prompt");
      }

      const outcome = params.behavior
        ? params.behavior({ storyKey, workflow, call: options })
        : { result: okResult(`${workflow}:${storyKey}`) };

      if (outcome.result.success) {
        if (outcome.nextStatus !== undefined) {
          params.setStatus(storyKey, outcome.nextStatus);
        } else {
          switch (workflow) {
            case "create-story":
              params.setStatus(storyKey, StoryStatus.ReadyForDev);
              break;
            case "dev-story":
              params.setStatus(storyKey, StoryStatus.Review);
              break;
            case "code-review":
              params.setStatus(storyKey, StoryStatus.Done);
              break;
          }
        }
      }

      return structuredClone(outcome.result);
    },
  };

  return { runner, callHistory };
}

describe("SprintOrchestrator", () => {
  const story1 = "0-1-story-1";
  const story2 = "0-2-story-2";
  const story3 = "0-3-story-3";

  test("Full sprint completion: 3 backlog stories -> all done", async () => {
    const { repo, setStatus } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Backlog },
      { storyKey: story2, status: StoryStatus.Backlog },
      { storyKey: story3, status: StoryStatus.Backlog },
    ]);

    const { store: runState } = makeRunStateStore();

    const { runner, callHistory } = makeDynamicRunner({
      storyKeys: [story1, story2, story3],
      setStatus,
    });

    const orchestrator = new SprintOrchestrator(
      repo,
      runner,
      runState,
      new StubLogger(),
      makeConfig({ maxRetries: 1 }),
    );

    const result = await orchestrator.runSprint();

    expect(result.status).toBe("complete");
    expect(result.totalStories).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.results).toHaveLength(3);
    expect(callHistory).toHaveLength(9);

    for (const call of callHistory) {
      expect(call.directory).toBe("/tmp/project");
      expect(call.timeout).toBe(123_000);
      expect(call.message).toContain("/tmp/project");
    }
  });

  test("Resume from failure: currentStory resumes first and completedStories are skipped", async () => {
    const { repo, setStatus, updateCalls } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Backlog },
      { storyKey: story2, status: StoryStatus.Backlog },
      { storyKey: story3, status: StoryStatus.Backlog },
    ]);

    const { store: runState } = makeRunStateStore({
      currentStory: story2,
      completedStories: [story1],
      completedWorkflows: {
        [story1]: [WorkflowType.CodeReview],
      },
    });

    const { runner, callHistory } = makeDynamicRunner({
      storyKeys: [story1, story2, story3],
      setStatus,
    });

    const orchestrator = new SprintOrchestrator(
      repo,
      runner,
      runState,
      new StubLogger(),
      makeConfig({ maxRetries: 1 }),
    );

    const result = await orchestrator.resumeSprint();

    expect(result.status).toBe("complete");
    expect(result.totalStories).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.results.map((r) => r.storyKey)).toEqual([story2, story3]);

    expect(callHistory[0]?.message).toContain(story2);
    expect(callHistory.some((c) => c.message.includes(story1))).toBe(false);

    expect(updateCalls).toEqual([{ storyKey: story1, status: StoryStatus.Done }]);
  });

  test("MaxRetries skipped: story2 never completes review -> skip and continue to story3", async () => {
    const { repo, setStatus, updateCalls, getStatus } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Backlog },
      { storyKey: story2, status: StoryStatus.Backlog },
      { storyKey: story3, status: StoryStatus.Backlog },
    ]);

    const { store: runState } = makeRunStateStore();

    const { runner, callHistory } = makeDynamicRunner({
      storyKeys: [story1, story2, story3],
      setStatus,
      behavior: ({ storyKey, workflow }) => {
        if (storyKey === story2 && workflow === "code-review") {
          return { result: okResult("review-not-done"), nextStatus: StoryStatus.InProgress };
        }
        return { result: okResult(`${workflow}:${storyKey}`) };
      },
    });

    const orchestrator = new SprintOrchestrator(
      repo,
      runner,
      runState,
      new StubLogger(),
      makeConfig({ maxRetries: 1 }),
    );

    const result = await orchestrator.runSprint();

    expect(result.status).toBe("complete");
    expect(result.totalStories).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);

    expect(result.results.map((r) => r.storyKey)).toEqual([story1, story2, story3]);
    expect(getStatus(story2)).toBe(StoryStatus.NeedsHumanIntervention);
    expect(updateCalls).toEqual([{ storyKey: story2, status: StoryStatus.NeedsHumanIntervention }]);

    const story3Calls = callHistory.filter((c) => c.message.includes(story3));
    expect(story3Calls.length).toBeGreaterThan(0);
  });

  test("Non-retry error pauses: story2 throws WorkflowHaltError -> paused and state saved", async () => {
    const { repo, setStatus } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Backlog },
      { storyKey: story2, status: StoryStatus.Backlog },
      { storyKey: story3, status: StoryStatus.Backlog },
    ]);

    const { store: runState, getState } = makeRunStateStore();

    const { runner, callHistory } = makeDynamicRunner({
      storyKeys: [story1, story2, story3],
      setStatus,
      behavior: ({ storyKey, workflow }) => {
        if (storyKey === story2 && workflow === "dev-story") {
          return { result: failResult("boom") };
        }
        return { result: okResult(`${workflow}:${storyKey}`) };
      },
    });

    const orchestrator = new SprintOrchestrator(
      repo,
      runner,
      runState,
      new StubLogger(),
      makeConfig({ maxRetries: 1 }),
    );

    const result = await orchestrator.runSprint();

    expect(result.status).toBe("paused");
    expect(result.totalStories).toBe(3);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);

    expect(result.results.map((r) => r.storyKey)).toEqual([story1, story2]);
    expect(getState().currentStory).toBe(story2);

    expect(callHistory.some((c) => c.message.includes(story3))).toBe(false);
    expect(callHistory.map((c) => c.agent).includes(AgentType.Hephaestus)).toBe(true);
  });

  test("Blind skip is prevented when completedStories entry is missing code-review workflow", async () => {
    const { repo, setStatus, updateCalls } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Review },
    ]);

    const { store: runState } = makeRunStateStore({
      completedStories: [story1],
      completedWorkflows: {},
    });

    const { runner, callHistory } = makeDynamicRunner({
      storyKeys: [story1],
      setStatus,
    });

    const logger = new StubLogger();
    const orchestrator = new SprintOrchestrator(
      repo,
      runner,
      runState,
      logger,
      makeConfig({ maxRetries: 1 }),
    );

    const result = await orchestrator.runSprint();

    expect(result.status).toBe("complete");
    expect(result.completed).toBe(1);
    expect(callHistory).toHaveLength(1);
    expect(callHistory[0]?.message).toContain(story1);
    expect(callHistory[0]?.message).toContain("code-review");
    expect(updateCalls).toEqual([]);
    expect(
      logger.warns.some((entry) =>
        entry.message.includes("story in completedStories but missing code-review workflow"),
      ),
    ).toBe(true);
  });

  test("Blind skip remains allowed when code-review workflow is already completed", async () => {
    const { repo, setStatus, updateCalls } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Review },
    ]);

    const { store: runState } = makeRunStateStore({
      completedStories: [story1],
      completedWorkflows: {
        [story1]: [WorkflowType.CodeReview],
      },
    });

    const { runner, callHistory } = makeDynamicRunner({
      storyKeys: [story1],
      setStatus,
    });

    const orchestrator = new SprintOrchestrator(
      repo,
      runner,
      runState,
      new StubLogger(),
      makeConfig({ maxRetries: 1 }),
    );

    const result = await orchestrator.runSprint();

    expect(result.status).toBe("complete");
    expect(result.completed).toBe(0);
    expect(callHistory).toHaveLength(0);
    expect(updateCalls).toEqual([{ storyKey: story1, status: StoryStatus.Done }]);
  });
});
