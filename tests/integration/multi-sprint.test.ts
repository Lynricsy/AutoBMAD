import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { parseDocument } from "yaml";

import { SprintStatusManager } from "../../src/core/state-manager.js";
import { RunStateStore } from "../../src/core/run-state.js";
import { SprintOrchestrator } from "../../src/core/sprint-orchestrator.js";
import { SprintArchiver } from "../../src/core/sprint-archiver.js";
import { MultiSprintOrchestrator } from "../../src/core/multi-sprint-orchestrator.js";
import { Logger, LogLevel } from "../../src/core/logger.js";
import {
  AgentType,
  ProjectCompleteReason,
  StoryStatus,
  type AutoBMADConfig,
  type IStateRepository,
  type IWorkflowRunner,
  type RunOptions,
  type RunResult,
  type RunState,
  type SprintResult,
} from "../../src/core/types.js";
import { DuplicateStoriesError, ProjectCompleteError } from "../../src/core/errors.js";

class StubLogger extends Logger {
  constructor() {
    super("integration-multi-sprint-test", {
      level: LogLevel.Debug,
      logDir: "/tmp/autobmad-integration-multi-sprint-test-logs",
      silent: true,
    });
  }

  debug(_message: string, _data?: Record<string, unknown>): void {}
  info(_message: string, _data?: Record<string, unknown>): void {}
  warn(_message: string, _data?: Record<string, unknown>): void {}
  error(_message: string, _data?: Record<string, unknown>): void {}
  fatal(_message: string, _data?: Record<string, unknown>): void {}
  table(_headers: string[], _rows: string[][]): void {}
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

function okResult(id = "test-session"): RunResult {
  return {
    sessionId: id,
    success: true,
    durationMs: 100,
    messageCount: 5,
    summary: "OK",
  };
}

function makeConfig(projectDir: string, overrides: Partial<AutoBMADConfig> = {}): AutoBMADConfig {
  return {
    projectDir,
    maxRetries: 3,
    timeout: 123_000,
    verbose: false,
    maxSprints: 10,
    ...overrides,
  };
}

function expectRunCall(
  call: RunOptions,
  expected: {
    agent: AgentType;
    workflowName: string;
    projectDir: string;
    timeout: number;
    storyKey?: string;
  },
): void {
  expect(call.agent).toBe(expected.agent);
  expect(call.directory).toBe(expected.projectDir);
  expect(call.timeout).toBe(expected.timeout);
  expect(call.message).toContain(expected.projectDir);
  expect(call.message).toContain(expected.workflowName);
  if (expected.storyKey) {
    expect(call.message).toContain(expected.storyKey);
  }
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

async function writeSprintStatusYaml(params: {
  yamlPath: string;
  storyStatuses: Array<{ storyKey: string; status: StoryStatus }>;
}): Promise<void> {
  const lines = [
    'generated: "2026-03-02T00:00:00Z"',
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

async function readRunStateJson(runStatePath: string): Promise<RunState> {
  const text = await Bun.file(runStatePath).text();
  return JSON.parse(text) as RunState;
}

function addBacklogStoryHandlers(params: {
  runner: IntegrationMockRunner;
  storyKey: string;
  projectDir: string;
  yamlPath: string;
  timeout: number;
  ids?: { create?: string; dev?: string; review?: string };
}): void {
  const ids = params.ids ?? {};

  params.runner.addHandler(async (call) => {
    expectRunCall(call, {
      agent: AgentType.Sisyphus,
      workflowName: "create-story",
      storyKey: params.storyKey,
      projectDir: params.projectDir,
      timeout: params.timeout,
    });
    await updateYamlStatus(params.yamlPath, params.storyKey, StoryStatus.ReadyForDev);
    return okResult(ids.create ?? `create:${params.storyKey}`);
  });

  params.runner.addHandler(async (call) => {
    expectRunCall(call, {
      agent: AgentType.Sisyphus,
      workflowName: "dev-story",
      storyKey: params.storyKey,
      projectDir: params.projectDir,
      timeout: params.timeout,
    });
    await updateYamlStatus(params.yamlPath, params.storyKey, StoryStatus.Review);
    return okResult(ids.dev ?? `dev:${params.storyKey}`);
  });

  params.runner.addHandler(async (call) => {
    expectRunCall(call, {
      agent: AgentType.Hephaestus,
      workflowName: "code-review",
      storyKey: params.storyKey,
      projectDir: params.projectDir,
      timeout: params.timeout,
    });
    await updateYamlStatus(params.yamlPath, params.storyKey, StoryStatus.Done);
    return okResult(ids.review ?? `review:${params.storyKey}`);
  });
}

function addSprintPlanningHandler(params: {
  runner: IntegrationMockRunner;
  sprintNumber: number;
  projectDir: string;
  yamlPath: string;
  timeout: number;
  beforePlanning?: () => Promise<void> | void;
  writeStatus: () => Promise<void>;
  id?: string;
}): void {
  params.runner.addHandler(async (call) => {
    expectRunCall(call, {
      agent: AgentType.Sisyphus,
      workflowName: "sprint-planning",
      projectDir: params.projectDir,
      timeout: params.timeout,
    });
    expect(call.message).toContain(`Current sprint number: ${params.sprintNumber}`);
    if (params.beforePlanning) {
      await params.beforePlanning();
    }
    await params.writeStatus();
    return okResult(params.id ?? `planning:${params.sprintNumber}`);
  });
}

function addSprintHandlers(params: {
  runner: IntegrationMockRunner;
  sprintNumber: number;
  storyKeys: string[];
  projectDir: string;
  yamlPath: string;
  timeout: number;
  beforePlanning?: () => Promise<void> | void;
}): void {
  addSprintPlanningHandler({
    runner: params.runner,
    sprintNumber: params.sprintNumber,
    projectDir: params.projectDir,
    yamlPath: params.yamlPath,
    timeout: params.timeout,
    beforePlanning: params.beforePlanning,
    writeStatus: async () => {
      await writeSprintStatusYaml({
        yamlPath: params.yamlPath,
        storyStatuses: params.storyKeys.map((storyKey) => ({
          storyKey,
          status: StoryStatus.Backlog,
        })),
      });
    },
  });

  for (const storyKey of params.storyKeys) {
    addBacklogStoryHandlers({
      runner: params.runner,
      storyKey,
      projectDir: params.projectDir,
      yamlPath: params.yamlPath,
      timeout: params.timeout,
    });
  }
}

class ClearingSprintArchiver {
  constructor(private readonly inner: SprintArchiver) {}

  async archive(sprintNumber: number): Promise<void> {
    await this.inner.archive(sprintNumber);
    await writeSprintStatusYaml({
      yamlPath: this.inner.getActiveStatusPath(),
      storyStatuses: [],
    });
  }
}

class ProjectCompleteAwareOrchestrator {
  constructor(
    private readonly inner: SprintOrchestrator,
    private readonly stateRepo: IStateRepository,
  ) {}

  async runSprint(): Promise<SprintResult> {
    const result = await this.inner.runSprint();

    if (result.status === "complete") {
      const stories = await this.stateRepo.getAllStories();
      if (stories.size === 0) {
        throw new ProjectCompleteError("no-new-stories");
      }
    }

    return result;
  }
}

describe("Integration: multi-sprint orchestration", () => {
  let projectDir = "";
  let artifactsDir = "";
  let yamlPath = "";
  let runStatePath = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "autobmad-int-multi-sprint-"));
    artifactsDir = join(projectDir, "_bmad-output/implementation-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    yamlPath = join(artifactsDir, "sprint-status.yaml");
    runStatePath = join(projectDir, ".autobmad-state.json");
  });

  afterEach(async () => {
    if (!projectDir) return;
    await rm(projectDir, { recursive: true, force: true });
  });

  test("full project completion: 3 sprints then 0 stories on 4th -> reason=NoNewStories", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

      const stateRepo = new SprintStatusManager(yamlPath);
      const runState = new RunStateStore(runStatePath);
      const logger = new StubLogger();
      const config = makeConfig(projectDir);
      const runner = new IntegrationMockRunner();

      const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
      const orchestrator = new ProjectCompleteAwareOrchestrator(sprintOrchestrator, stateRepo);
      const baseArchiver = new SprintArchiver(artifactsDir);
      const archiver = new ClearingSprintArchiver(baseArchiver);

      addSprintHandlers({
        runner,
        sprintNumber: 1,
        storyKeys: ["1-1-feature-a"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });
      addSprintHandlers({
        runner,
        sprintNumber: 2,
        storyKeys: ["2-1-feature-b"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });
      addSprintHandlers({
        runner,
        sprintNumber: 3,
        storyKeys: ["3-1-feature-c"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });

      addSprintPlanningHandler({
        runner,
        sprintNumber: 4,
        projectDir,
        yamlPath,
        timeout: config.timeout,
        writeStatus: async () => {
          await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });
        },
      });

      const multi = new MultiSprintOrchestrator(
              orchestrator,
              runState,
              archiver,
              stateRepo,
              { maxSprints: 10 },
              logger,
            );

      const result = await multi.runAllSprints();

      expect(result.reason).toBe(ProjectCompleteReason.NoNewStories);
      expect(result.totalSprints).toBe(3);
      expect(result.sprintResults).toHaveLength(3);
      expect(result.sprintResults.map((r) => r.status)).toEqual(["complete", "complete", "complete"]);

      expect(await Bun.file(baseArchiver.getArchivePath(1)).exists()).toBe(true);
      expect(await Bun.file(baseArchiver.getArchivePath(2)).exists()).toBe(true);
      expect(await Bun.file(baseArchiver.getArchivePath(3)).exists()).toBe(true);
      expect(await Bun.file(baseArchiver.getArchivePath(4)).exists()).toBe(false);

      const expectedCalls = 3 * 4 + 1;
      expect(runner.callHistory).toHaveLength(expectedCalls);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("maxSprints reached: maxSprints=2 completes exactly 2 sprints -> reason=MaxSprintsReached", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

      const stateRepo = new SprintStatusManager(yamlPath);
      const runState = new RunStateStore(runStatePath);
      const logger = new StubLogger();
      const config = makeConfig(projectDir);
      const runner = new IntegrationMockRunner();

      const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
      const orchestrator = new ProjectCompleteAwareOrchestrator(sprintOrchestrator, stateRepo);
      const baseArchiver = new SprintArchiver(artifactsDir);
      const archiver = new ClearingSprintArchiver(baseArchiver);

      addSprintHandlers({
        runner,
        sprintNumber: 1,
        storyKeys: ["1-1-story-a"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });
      addSprintHandlers({
        runner,
        sprintNumber: 2,
        storyKeys: ["2-1-story-b"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });

      const multi = new MultiSprintOrchestrator(
              orchestrator,
              runState,
              archiver,
              stateRepo,
              { maxSprints: 2 },
              logger,
            );

      const result = await multi.runAllSprints();

      expect(result.reason).toBe(ProjectCompleteReason.MaxSprintsReached);
      expect(result.totalSprints).toBe(2);
      expect(result.sprintResults).toHaveLength(2);
      expect(result.sprintResults.map((r) => r.status)).toEqual(["complete", "complete"]);

      expect(await Bun.file(baseArchiver.getArchivePath(1)).exists()).toBe(true);
      expect(await Bun.file(baseArchiver.getArchivePath(2)).exists()).toBe(true);

      const planningCalls = runner.callHistory.filter((c) => c.message.includes("sprint-planning"));
      expect(planningCalls).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("duplicate stories detected: sprint 2 repeats sprint 1 -> throws DuplicateStoriesError", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

      const stateRepo = new SprintStatusManager(yamlPath);
      const runState = new RunStateStore(runStatePath);
      const logger = new StubLogger();
      const config = makeConfig(projectDir);
      const runner = new IntegrationMockRunner();

      const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
      const orchestrator = new ProjectCompleteAwareOrchestrator(sprintOrchestrator, stateRepo);
      const baseArchiver = new SprintArchiver(artifactsDir);
      const archiver = new ClearingSprintArchiver(baseArchiver);

      addSprintHandlers({
        runner,
        sprintNumber: 1,
        storyKeys: ["1-1-same", "1-2-same"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });
      addSprintHandlers({
        runner,
        sprintNumber: 2,
        storyKeys: ["2-1-same", "2-2-same"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });

      const multi = new MultiSprintOrchestrator(
              orchestrator,
              runState,
              archiver,
              stateRepo,
              { maxSprints: 2 },
              logger,
            );

      try {
        await multi.runAllSprints();
        throw new Error("expected DuplicateStoriesError");
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateStoriesError);
        const dup = err as DuplicateStoriesError;
        expect(dup.sprintNumber).toBe(2);
        expect(dup.duplicateKeys).toEqual(["2-1-same", "2-2-same"]);
      }

      expect(await Bun.file(baseArchiver.getArchivePath(1)).exists()).toBe(true);
      expect(await Bun.file(baseArchiver.getArchivePath(2)).exists()).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("sprint failure: one sprint returns failed, records error, continues to next sprint", async () => {
    await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

      const stateRepo = new SprintStatusManager(yamlPath);
      const runState = new RunStateStore(runStatePath);
      const logger = new StubLogger();
      const warnSpy = spyOn(logger, "warn");
      const config = makeConfig(projectDir);
      const runner = new IntegrationMockRunner();

      const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
      const orchestrator = new ProjectCompleteAwareOrchestrator(sprintOrchestrator, stateRepo);
      const archiver = new SprintArchiver(artifactsDir);

      addSprintPlanningHandler({
        runner,
        sprintNumber: 1,
        projectDir,
        yamlPath,
        timeout: config.timeout,
        writeStatus: async () => {
          const corruptYamlMissingRequiredFields = [
            'generated: "2026-03-02T00:00:00Z"',
            "development_status:",
            "  epic-0: in-progress",
            "",
          ].join("\n");
          await Bun.write(yamlPath, corruptYamlMissingRequiredFields);
        },
      });

      addSprintHandlers({
        runner,
        sprintNumber: 2,
        storyKeys: ["2-1-ok"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
        beforePlanning: async () => {
          const state = await readRunStateJson(runStatePath);
          const codes = state.errors.map((e) => e.code);
          expect(codes).toContain("E_SPRINT_FAILED");
        },
      });

      const multi = new MultiSprintOrchestrator(
              orchestrator,
              runState,
              archiver,
              stateRepo,
              { maxSprints: 2 },
              logger,
            );

      const result = await multi.runAllSprints();

      expect(result.sprintResults.map((r) => r.status)).toEqual(["failed", "complete"]);
      expect(await Bun.file(archiver.getArchivePath(1)).exists()).toBe(false);
      expect(await Bun.file(archiver.getArchivePath(2)).exists()).toBe(true);

      const messages = warnSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(messages).toContain("Sprint 1 failed, skipping to next");
  });

  test("resume from crash: currentSprint=2 starts from sprint 2, not 1", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

      const stateRepo = new SprintStatusManager(yamlPath);
      const runState = new RunStateStore(runStatePath);
      const logger = new StubLogger();
      const config = makeConfig(projectDir);
      const runner = new IntegrationMockRunner();

      const state = await runState.load();
      state.currentSprint = 2;
      await runState.save(state);

      const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
      const orchestrator = new ProjectCompleteAwareOrchestrator(sprintOrchestrator, stateRepo);
      const archiver = new SprintArchiver(artifactsDir);

      addSprintPlanningHandler({
        runner,
        sprintNumber: 2,
        projectDir,
        yamlPath,
        timeout: config.timeout,
        writeStatus: async () => {
          await writeSprintStatusYaml({
            yamlPath,
            storyStatuses: [{ storyKey: "2-1-resume", status: StoryStatus.Backlog }],
          });
        },
      });
      addBacklogStoryHandlers({
        runner,
        storyKey: "2-1-resume",
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });

      const multi = new MultiSprintOrchestrator(
              orchestrator,
              runState,
              archiver,
              stateRepo,
              { maxSprints: 2 },
              logger,
            );

      const result = await multi.runAllSprints();

      expect(result.totalSprints).toBe(1);
      expect(result.reason).toBe(ProjectCompleteReason.MaxSprintsReached);
      expect(runner.callHistory[0]?.message).toContain("Current sprint number: 2");

      expect(await Bun.file(archiver.getArchivePath(1)).exists()).toBe(false);
      expect(await Bun.file(archiver.getArchivePath(2)).exists()).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("archive verification: sprint-1-status.yaml exists and matches active content", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

      const stateRepo = new SprintStatusManager(yamlPath);
      const runState = new RunStateStore(runStatePath);
      const logger = new StubLogger();
      const config = makeConfig(projectDir);
      const runner = new IntegrationMockRunner();

      const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
      const orchestrator = new ProjectCompleteAwareOrchestrator(sprintOrchestrator, stateRepo);
      const archiver = new SprintArchiver(artifactsDir);

      addSprintHandlers({
        runner,
        sprintNumber: 1,
        storyKeys: ["1-1-alpha", "1-2-beta"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
      });

      const multi = new MultiSprintOrchestrator(
              orchestrator,
              runState,
              archiver,
              stateRepo,
              { maxSprints: 1 },
              logger,
            );

      await multi.runAllSprints();

      const activePath = archiver.getActiveStatusPath();
      const archivePath = archiver.getArchivePath(1);
      expect(await Bun.file(activePath).exists()).toBe(true);
      expect(await Bun.file(archivePath).exists()).toBe(true);

      const active = await Bun.file(activePath).text();
      const archived = await Bun.file(archivePath).text();
      expect(archived).toBe(active);
      expect(archived).toContain("1-1-alpha: done");
      expect(archived).toContain("1-2-beta: done");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("state transitions: currentSprint increments and completedStories resets between sprints", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeSprintStatusYaml({ yamlPath, storyStatuses: [] });

      const stateRepo = new SprintStatusManager(yamlPath);
      const runState = new RunStateStore(runStatePath);
      const logger = new StubLogger();
      const config = makeConfig(projectDir);
      const runner = new IntegrationMockRunner();

      const sprintOrchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
      const orchestrator = new ProjectCompleteAwareOrchestrator(sprintOrchestrator, stateRepo);
      const baseArchiver = new SprintArchiver(artifactsDir);
      const archiver = new ClearingSprintArchiver(baseArchiver);

      addSprintHandlers({
        runner,
        sprintNumber: 1,
        storyKeys: ["1-1-first"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
        beforePlanning: async () => {
          const state = await readRunStateJson(runStatePath);
          expect(state.currentSprint ?? 1).toBe(1);
          expect(state.completedStories).toHaveLength(0);
        },
      });

      addSprintHandlers({
        runner,
        sprintNumber: 2,
        storyKeys: ["2-1-second"],
        projectDir,
        yamlPath,
        timeout: config.timeout,
        beforePlanning: async () => {
          const state = await readRunStateJson(runStatePath);
          expect(state.currentSprint ?? 1).toBe(2);
          expect(state.completedStories).toHaveLength(0);
          expect(state.currentStory).toBe(null);
        },
      });

      const multi = new MultiSprintOrchestrator(
              orchestrator,
              runState,
              archiver,
              stateRepo,
              { maxSprints: 2 },
              logger,
            );

      const result = await multi.runAllSprints();

      expect(result.totalSprints).toBe(2);
      expect(result.sprintResults.map((r) => r.status)).toEqual(["complete", "complete"]);
    } finally {
      logSpy.mockRestore();
    }
  });
});
