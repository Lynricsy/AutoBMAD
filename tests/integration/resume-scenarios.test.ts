import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { parseDocument } from "yaml";

import { SprintOrchestrator } from "../../src/core/sprint-orchestrator.js";
import { MultiSprintOrchestrator } from "../../src/core/multi-sprint-orchestrator.js";
import { RunStateStore } from "../../src/core/run-state.js";
import { SprintStatusManager } from "../../src/core/state-manager.js";
import { Logger, LogLevel } from "../../src/core/logger.js";
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

// ─── Test Helpers (local to this file per project convention) ──────────────────

class StubLogger extends Logger {
  readonly infos: Array<{ message: string; data?: Record<string, unknown> }> = [];
  readonly warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
  readonly errors_: Array<{ message: string; data?: Record<string, unknown> }> = [];

  constructor() {
    super("integration-resume-test", {
      level: LogLevel.Debug,
      logDir: "/tmp/autobmad-integration-resume-test-logs",
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
    this.errors_.push({ message, data });
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
    generated: "2026-03-12",
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

  const store: IRunStateStore = {
    async load(): Promise<RunState> {
      return structuredClone(state);
    },

    async save(next: RunState): Promise<void> {
      state = structuredClone(next);
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
    getState: () => structuredClone(state),
  };
}

type RunnerBehavior = (params: {
  storyKey: string;
  workflow: "create-story" | "dev-story" | "code-review";
  call: RunOptions;
}) => { result: RunResult; nextStatus?: StoryStatus };

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

// ─── File-based helpers (for scenarios 4-6) ───────────────────────────────────

async function writeSprintStatusYaml(params: {
  yamlPath: string;
  storyStatuses: Array<{ storyKey: string; status: StoryStatus }>;
}): Promise<void> {
  const lines = [
    'generated: "2026-03-12T00:00:00Z"',
    'project: "test-project"',
    'project_key: "TP"',
    'tracking_system: "file-based"',
    'story_location: "_bmad-output/stories"',
    "development_status:",
    "  epic-0: in-progress",
    ...params.storyStatuses.map((s) => `  ${s.storyKey}: ${s.status}`),
    "",
  ].join("\n");

  await Bun.write(params.yamlPath, lines);
}

async function updateYamlStatus(
  yamlPath: string,
  storyKey: string,
  newStatus: StoryStatus,
): Promise<void> {
  const content = await Bun.file(yamlPath).text();
  const doc = parseDocument(content, { prettyErrors: true });
  doc.setIn(["development_status", storyKey], newStatus);
  await Bun.write(yamlPath, doc.toString());
}

class IntegrationMockRunner implements IWorkflowRunner {
  private callIndex = 0;
  public callHistory: RunOptions[] = [];
  private handlers: Array<(options: RunOptions) => Promise<RunResult>> = [];

  addHandler(handler: (options: RunOptions) => Promise<RunResult>): void {
    this.handlers.push(handler);
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.callHistory.push(structuredClone(options));

    const handler = this.handlers[this.callIndex++];
    if (!handler) {
      throw new Error(
        `No handler for call index ${this.callIndex - 1}: agent=${options.agent}, message=${options.message.substring(0, 80)}`,
      );
    }

    return await handler(options);
  }
}

async function readRunStateJson(runStatePath: string): Promise<RunState> {
  const text = await Bun.file(runStatePath).text();
  return JSON.parse(text) as RunState;
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe("Integration: Resume Scenarios", () => {
  // Scenarios 1-3 use in-memory helpers (no file I/O needed)
  // Scenarios 4-6 use real file I/O with temp directories

  const story1 = "0-1-story-alpha";
  const _story2 = "0-2-story-beta";

  // ── Scenario 1: StoryCompleteError blindness ──────────────────────────────

  test("StoryCompleteError blindness: Done story missing CodeReview is downgraded by reconciler, then code-review runs to completion", async () => {
    // Setup: story is Done in YAML, has DevStory workflow recorded but NOT CodeReview.
    // currentStory=null so reconciler fires (completedWorkflows has entries).
    // Reconciler should detect the missing CodeReview and downgrade to Review.
    // Then getNextStory picks it up and code-review runs.
    const { repo, setStatus } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Done },
    ]);

    const { store: runState } = makeRunStateStore({
      completedStories: [],
      completedWorkflows: {
        [story1]: [WorkflowType.CreateStory, WorkflowType.DevStory],
      },
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
      makeConfig(),
    );

    const result = await orchestrator.runSprint();

    // Verify sprint completed
    expect(result.status).toBe("complete");
    expect(result.completed).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.storyKey).toBe(story1);
    expect(result.results[0]?.success).toBe(true);

    // Verify only code-review ran (not create-story or dev-story)
    expect(callHistory).toHaveLength(1);
    expect(callHistory[0]?.message).toContain("code-review");
    expect(callHistory[0]?.message).toContain(story1);
    expect(callHistory[0]?.agent).toBe(AgentType.Hephaestus);

    // Verify reconciler logged the downgrade
    expect(
      logger.warns.some((entry) =>
        entry.data?.event === "story-downgraded",
      ),
    ).toBe(true);
    expect(
      logger.infos.some((entry) =>
        entry.data?.event === "resume-reconciliation-result",
      ),
    ).toBe(true);
  });

  // ── Scenario 2: Orphan Done ──────────────────────────────────────────────

  test("Orphan Done: Done story not in completedStories with no workflow history is downgraded, picked up by getNextStory, and completes", async () => {
    // Setup: story is Done in YAML but completedStories is empty, completedWorkflows is empty.
    // Some retries exist from a previous crash (triggers reconciliation).
    // Reconciler sees Done story not in completedStories without CodeReview → downgrade to Review.
    // getNextStory picks it up at Review → code-review runs → completes.
    const { repo, setStatus } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.Done },
    ]);

    const { store: runState } = makeRunStateStore({
      completedStories: [],
      completedWorkflows: {},
      retries: { "0-9-old-crashed-story": 1 },
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
      makeConfig(),
    );

    const result = await orchestrator.runSprint();

    // Verify sprint completed
    expect(result.status).toBe("complete");
    expect(result.completed).toBe(1);
    expect(result.results[0]?.storyKey).toBe(story1);

    // Verify code-review ran for the orphan story
    expect(callHistory).toHaveLength(1);
    expect(callHistory[0]?.message).toContain("code-review");
    expect(callHistory[0]?.message).toContain(story1);

    // Verify reconciler detected the inconsistency
    expect(
      logger.warns.some((entry) =>
        entry.data?.event === "story-downgraded",
      ),
    ).toBe(true);
  });

  // ── Scenario 3: Blind skip prevention ────────────────────────────────────

  test("Blind skip prevention: story in completedStories with only DevStory workflow is NOT skipped and re-processes through dev+review", async () => {
    // Setup: story is InProgress in YAML, listed in completedStories but only has
    // DevStory in completedWorkflows (missing CodeReview).
    // Blind-skip guard in orchestrator should detect missing CodeReview,
    // remove from completedStories set, and re-process the story.
    const { repo, setStatus } = makeInMemoryStateRepo([
      { storyKey: story1, status: StoryStatus.InProgress },
    ]);

    const { store: runState } = makeRunStateStore({
      completedStories: [story1],
      completedWorkflows: {
        [story1]: [WorkflowType.CreateStory, WorkflowType.DevStory],
      },
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
      makeConfig(),
    );

    const result = await orchestrator.runSprint();

    // Verify sprint completed
    expect(result.status).toBe("complete");
    expect(result.completed).toBe(1);
    expect(result.results[0]?.storyKey).toBe(story1);
    expect(result.results[0]?.success).toBe(true);

    // Verify both dev-story and code-review ran (not just code-review)
    // because story is InProgress, lifecycle = [DevStory, CodeReview]
    expect(callHistory).toHaveLength(2);
    expect(callHistory[0]?.message).toContain("dev-story");
    expect(callHistory[1]?.message).toContain("code-review");

    // Verify blind-skip-prevented was logged
    expect(
      logger.warns.some((entry) =>
        entry.message.includes("story in completedStories but missing code-review workflow"),
      ),
    ).toBe(true);
  });

  // ── Scenarios 4-6: File-based (real RunStateStore / SprintStatusManager) ──

  let projectDir = "";
  let artifactsDir = "";
  let yamlPath = "";
  let runStatePath = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "autobmad-int-resume-"));
    artifactsDir = join(projectDir, "_bmad-output/implementation-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    yamlPath = join(artifactsDir, "sprint-status.yaml");
    runStatePath = join(projectDir, ".autobmad-state.json");
  });

  afterEach(async () => {
    if (!projectDir) return;
    await rm(projectDir, { recursive: true, force: true });
  });

  // ── Scenario 4: Multi-sprint reset ───────────────────────────────────────

  test("Multi-sprint reset: failed sprint 1 resets state, sprint 2 starts with empty completedStories and completedWorkflows", async () => {
    // Setup: Sprint 1 planning writes corrupt YAML (missing required fields) →
    // getAllStories throws StateCorruptionError → sprint fails.
    // MultiSprintOrchestrator resets state and moves to sprint 2.
    // Sprint 2 planning writes valid YAML → processes normally.
    // Verify: sprint 2 starts with clean state (empty completedStories/completedWorkflows).
    await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

    const stateRepo = new SprintStatusManager(yamlPath);
    const runState = new RunStateStore(runStatePath);
    const logger = new StubLogger();
    const config = makeConfig({ projectDir, maxSprints: 2 });
    const runner = new IntegrationMockRunner();

    // Sprint 1 planning: writes corrupt YAML (missing required fields)
    runner.addHandler(async (call) => {
      expect(call.message).toContain("sprint-planning");
      expect(call.message).toContain("Current sprint number: 1");

      const corruptYaml = [
        'generated: "2026-03-12T00:00:00Z"',
        "development_status:",
        "  epic-0: in-progress",
        "",
      ].join("\n");
      await Bun.write(yamlPath, corruptYaml);
      return okResult("planning:1");
    });

    // Sprint 2 planning: writes valid YAML
    const sprint2Story = "2-1-recovery-story";
    runner.addHandler(async (call) => {
      expect(call.message).toContain("sprint-planning");
      expect(call.message).toContain("Current sprint number: 2");

      // Verify state was reset before sprint 2
      const state = await readRunStateJson(runStatePath);
      expect(state.completedStories).toHaveLength(0);
      expect(Object.keys(state.completedWorkflows)).toHaveLength(0);
      expect(state.currentSprint).toBe(2);
      // Errors from sprint 1 failure should be preserved
      const codes = state.errors.map((e) => e.code);
      expect(codes).toContain("E_SPRINT_FAILED");

      await writeSprintStatusYaml({
        yamlPath,
        storyStatuses: [{ storyKey: sprint2Story, status: StoryStatus.Backlog }],
      });
      return okResult("planning:2");
    });

    // Sprint 2 story handlers: create → dev → review
    runner.addHandler(async () => {
      await updateYamlStatus(yamlPath, sprint2Story, StoryStatus.ReadyForDev);
      return okResult("create:2-1");
    });
    runner.addHandler(async () => {
      await updateYamlStatus(yamlPath, sprint2Story, StoryStatus.Review);
      return okResult("dev:2-1");
    });
    runner.addHandler(async () => {
      await updateYamlStatus(yamlPath, sprint2Story, StoryStatus.Done);
      return okResult("review:2-1");
    });

    const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);

    // No-op archiver (sprint 1 has 0 stories so archive isn't called for it;
    // sprint 2 completes and archive is called)
    const archiver = {
      async archive(_sprintNumber: number): Promise<void> {
        // no-op for testing
      },
    };

    const multi = new MultiSprintOrchestrator(
      sprintOrchestrator,
      runState,
      archiver,
      stateRepo,
      { maxSprints: 2 },
      logger,
    );

    const result = await multi.runAllSprints();

    // Sprint 1 failed, sprint 2 completed
    expect(result.sprintResults).toHaveLength(2);
    expect(result.sprintResults[0]?.status).toBe("failed");
    expect(result.sprintResults[1]?.status).toBe("complete");
    expect(result.sprintResults[1]?.completed).toBe(1);

    // Verify reset log
    expect(
      logger.warns.some((entry) =>
        entry.message.includes("Sprint 1 failed, skipping to next"),
      ),
    ).toBe(true);
  });

  // ── Scenario 5: Legacy migration + resume ────────────────────────────────

  test("Legacy migration: state file without completedWorkflows field triggers migration, reconciler grandfathers completed stories, remaining stories process normally", async () => {
    // Setup: Write a legacy JSON state (no completedWorkflows field) with story1 in completedStories.
    // YAML has story1=Done and story2=Backlog.
    // RunStateStore.load() should migrate (add empty completedWorkflows).
    // Reconciler: story1 Done + in completedStories + no completedWorkflows → grandfather (add all 3 workflows).
    // Then story2 is processed normally (create → dev → review → done).
    const legacyStory = "0-1-legacy-done";
    const newStory = "0-2-new-backlog";

    await writeSprintStatusYaml({
      yamlPath,
      storyStatuses: [
        { storyKey: legacyStory, status: StoryStatus.Done },
        { storyKey: newStory, status: StoryStatus.Backlog },
      ],
    });

    // Write legacy state JSON WITHOUT completedWorkflows field
    const legacyState = {
      currentStory: null,
      retries: {},
      errors: [],
      startedAt: "2026-03-12T00:00:00.000Z",
      lastUpdatedAt: "2026-03-12T00:00:00.000Z",
      completedStories: [legacyStory],
      currentSprint: 1,
    };
    writeFileSync(runStatePath, JSON.stringify(legacyState, null, 2), "utf-8");

    const stateRepo = new SprintStatusManager(yamlPath);
    const logger = new StubLogger();
    const runState = new RunStateStore(runStatePath, logger);
    const config = makeConfig({ projectDir });
    const runner = new IntegrationMockRunner();

    // Handlers for newStory: Backlog → create-story → ReadyForDev → dev-story → Review → code-review → Done
    runner.addHandler(async (call) => {
      expect(call.message).toContain("create-story");
      expect(call.message).toContain(newStory);
      await updateYamlStatus(yamlPath, newStory, StoryStatus.ReadyForDev);
      return okResult("create:new");
    });
    runner.addHandler(async (call) => {
      expect(call.message).toContain("dev-story");
      expect(call.message).toContain(newStory);
      await updateYamlStatus(yamlPath, newStory, StoryStatus.Review);
      return okResult("dev:new");
    });
    runner.addHandler(async (call) => {
      expect(call.message).toContain("code-review");
      expect(call.message).toContain(newStory);
      await updateYamlStatus(yamlPath, newStory, StoryStatus.Done);
      return okResult("review:new");
    });

    const orchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
    const result = await orchestrator.runSprint();

    // Verify sprint completed with only the new story processed
    expect(result.status).toBe("complete");
    expect(result.completed).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.storyKey).toBe(newStory);

    // Verify legacy story was NOT re-processed (only newStory calls in runner)
    expect(runner.callHistory).toHaveLength(3);
    expect(runner.callHistory.every((c) => c.message.includes(newStory))).toBe(true);

    // Verify migration log was emitted
    expect(
      logger.infos.some((entry) =>
        entry.message.includes("Migrating state: adding completedWorkflows"),
      ),
    ).toBe(true);

    // Verify grandfather clause was applied (state should have all 3 workflows for legacy story)
    expect(
      logger.infos.some((entry) =>
        entry.data?.event === "legacy-story-grandfathered",
      ),
    ).toBe(true);

    // Read final state and verify grandfathered workflows are persisted
    const finalState = await readRunStateJson(runStatePath);
    const legacyWorkflows = finalState.completedWorkflows[legacyStory];
    expect(legacyWorkflows).toBeDefined();
    expect(legacyWorkflows).toContain(WorkflowType.CreateStory);
    expect(legacyWorkflows).toContain(WorkflowType.DevStory);
    expect(legacyWorkflows).toContain(WorkflowType.CodeReview);

    // Verify both stories ended up Done in YAML
    const finalStatus = await stateRepo.readStatus();
    expect(finalStatus.development_status[legacyStory]).toBe(StoryStatus.Done);
    expect(finalStatus.development_status[newStory]).toBe(StoryStatus.Done);
  });

  // ── Scenario 6: Corrupt state recovery ───────────────────────────────────

  test("Corrupt state recovery: corrupt JSON is silently recovered with backup, fresh state is created, sprint proceeds normally", async () => {
    // Setup: Write invalid JSON to the state file. YAML has story1=Backlog.
    // RunStateStore.load() should detect corrupt JSON, create a backup file,
    // log a warning, and return a fresh default state.
    // Sprint then runs normally from scratch.
    const storyKey = "0-1-after-corruption";

    await writeSprintStatusYaml({
      yamlPath,
      storyStatuses: [{ storyKey, status: StoryStatus.Backlog }],
    });

    // Write corrupt JSON to state file
    const corruptJson = '{"currentStory": "half-written", retries: {broken json!!!';
    writeFileSync(runStatePath, corruptJson, "utf-8");

    const stateRepo = new SprintStatusManager(yamlPath);
    const logger = new StubLogger();
    const runState = new RunStateStore(runStatePath, logger);
    const config = makeConfig({ projectDir });
    const runner = new IntegrationMockRunner();

    // Handlers for story: Backlog → create → ReadyForDev → dev → Review → review → Done
    runner.addHandler(async (call) => {
      expect(call.message).toContain("create-story");
      expect(call.message).toContain(storyKey);
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.ReadyForDev);
      return okResult("create");
    });
    runner.addHandler(async (call) => {
      expect(call.message).toContain("dev-story");
      expect(call.message).toContain(storyKey);
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.Review);
      return okResult("dev");
    });
    runner.addHandler(async (call) => {
      expect(call.message).toContain("code-review");
      expect(call.message).toContain(storyKey);
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.Done);
      return okResult("review");
    });

    const orchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
    const result = await orchestrator.runSprint();

    // Verify sprint completed normally
    expect(result.status).toBe("complete");
    expect(result.completed).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.storyKey).toBe(storyKey);
    expect(result.results[0]?.success).toBe(true);

    // Verify all 3 workflow steps ran
    expect(runner.callHistory).toHaveLength(3);

    // Verify corrupt recovery was logged
    expect(
      logger.warns.some((entry) =>
        entry.data?.event === "corrupt-state-recovery",
      ),
    ).toBe(true);

    // Verify backup file was created (filename pattern: {path}.corrupt.{timestamp})
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(projectDir);
    const backupFiles = files.filter((f) => f.includes(".corrupt."));
    expect(backupFiles.length).toBeGreaterThanOrEqual(1);

    // Verify the backup contains the original corrupt content
    const backupPath = join(projectDir, backupFiles[0]!);
    const backupContent = await Bun.file(backupPath).text();
    expect(backupContent).toBe(corruptJson);

    // Verify final YAML status is Done
    const finalStatus = await stateRepo.readStatus();
    expect(finalStatus.development_status[storyKey]).toBe(StoryStatus.Done);
  });
});
