import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { join } from "node:path";
import { mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { parseDocument } from "yaml";

import { SprintStatusManager } from "../../src/core/state-manager.js";
import { RunStateStore } from "../../src/core/run-state.js";
import { SprintOrchestrator } from "../../src/core/sprint-orchestrator.js";
import { Logger, LogLevel } from "../../src/core/logger.js";
import {
  AgentType,
  StoryStatus,
  type AutoBMADConfig,
  type IWorkflowRunner,
  type RunOptions,
  type RunResult,
} from "../../src/core/types.js";

class StubLogger extends Logger {
  constructor() {
    super("integration-full-workflow-test", {
      level: LogLevel.Debug,
      logDir: "/tmp/autobmad-integration-full-workflow-test-logs",
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
    'generated: "2025-01-01T00:00:00Z"',
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

describe("Integration: full AutoBMAD workflow", () => {
  let projectDir = "";
  let yamlPath = "";
  let runStatePath = "";

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "autobmad-int-"));
    const artifactsDir = join(projectDir, "_bmad-output/implementation-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    yamlPath = join(artifactsDir, "sprint-status.yaml");
    runStatePath = join(projectDir, ".autobmad-state.json");
  });

  afterEach(async () => {
    if (!projectDir) return;
    await rm(projectDir, { recursive: true, force: true });
  });

  test("complete sprint flow - 3 stories all succeed", async () => {
    await copyFile(join(process.cwd(), "tests/fixtures/sprint-status-mixed.yaml"), yamlPath);

    const stateRepo = new SprintStatusManager(yamlPath);
    const runState = new RunStateStore(runStatePath);
    const logger = new StubLogger();
    const config = makeConfig(projectDir);
    const runner = new IntegrationMockRunner();

    const story02 = "0-2-user-registration";
    const story03 = "0-3-session-management";

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey: story02,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story02, StoryStatus.Review);
      return okResult("dev:0-2");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Hephaestus,
        workflowName: "code-review",
        storyKey: story02,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story02, StoryStatus.Done);
      return okResult("review:0-2");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "create-story",
        storyKey: story03,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story03, StoryStatus.ReadyForDev);
      return okResult("create:0-3");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey: story03,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story03, StoryStatus.Review);
      return okResult("dev:0-3");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Hephaestus,
        workflowName: "code-review",
        storyKey: story03,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story03, StoryStatus.Done);
      return okResult("review:0-3");
    });

    const orchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
    const result = await orchestrator.runSprint();

    expect(result.status).toBe("complete");
    expect(result.totalStories).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.results.map((r) => r.storyKey)).toEqual([story02, story03]);
    expect(runner.callHistory).toHaveLength(5);
    expect(runner.callHistory.map((c) => c.agent)).toEqual([
      AgentType.Sisyphus,
      AgentType.Hephaestus,
      AgentType.Sisyphus,
      AgentType.Sisyphus,
      AgentType.Hephaestus,
    ]);

    const finalStatus = await stateRepo.readStatus();
    expect(finalStatus.development_status[story02]).toBe(StoryStatus.Done);
    expect(finalStatus.development_status[story03]).toBe(StoryStatus.Done);
  });

  test("fix loop - story needs retry", async () => {
    const storyKey = "0-1-fix-loop-story";
    await writeSprintStatusYaml({
      yamlPath,
      storyStatuses: [{ storyKey, status: StoryStatus.Backlog }],
    });

    const stateRepo = new SprintStatusManager(yamlPath);
    const runState = new RunStateStore(runStatePath);
    const logger = new StubLogger();
    const config = makeConfig(projectDir, { maxRetries: 3 });
    const runner = new IntegrationMockRunner();

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "create-story",
        storyKey,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.ReadyForDev);
      return okResult("create");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.Review);
      return okResult("dev-0");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Hephaestus,
        workflowName: "code-review",
        storyKey,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.InProgress);
      return okResult("review-0");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.Review);
      return okResult("dev-1");
    });

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Hephaestus,
        workflowName: "code-review",
        storyKey,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.Done);
      return okResult("review-1");
    });

    const orchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
    const result = await orchestrator.runSprint();

    expect(result.status).toBe("complete");
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.retries).toBeGreaterThanOrEqual(1);

    const finalStatus = await stateRepo.readStatus();
    expect(finalStatus.development_status[storyKey]).toBe(StoryStatus.Done);
  });

  test("resume after failure", async () => {
    await copyFile(join(process.cwd(), "tests/fixtures/sprint-status-mixed.yaml"), yamlPath);

    const story02 = "0-2-user-registration";
    const story03 = "0-3-session-management";

    const logger = new StubLogger();
    const config = makeConfig(projectDir);
    const stateRepo1 = new SprintStatusManager(yamlPath);
    const runState1 = new RunStateStore(runStatePath);
    const runner1 = new IntegrationMockRunner();

    runner1.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey: story02,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story02, StoryStatus.Review);
      return okResult("dev:0-2");
    });
    runner1.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Hephaestus,
        workflowName: "code-review",
        storyKey: story02,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story02, StoryStatus.Done);
      return okResult("review:0-2");
    });
    runner1.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "create-story",
        storyKey: story03,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story03, StoryStatus.ReadyForDev);
      return okResult("create:0-3");
    });
    runner1.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey: story03,
        projectDir,
        timeout: config.timeout,
      });
      throw new Error("boom");
    });

    const orchestrator1 = new SprintOrchestrator(
      stateRepo1,
      runner1,
      runState1,
      logger,
      config,
    );
    const first = await orchestrator1.runSprint();

    expect(first.status).toBe("paused");
    expect(first.completed).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.skipped).toBe(0);
    expect(first.results.map((r) => r.storyKey)).toEqual([story02, story03]);

    const stateRepo2 = new SprintStatusManager(yamlPath);
    const runState2 = new RunStateStore(runStatePath);
    const runner2 = new IntegrationMockRunner();

    runner2.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey: story03,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story03, StoryStatus.Review);
      return okResult("dev:0-3");
    });
    runner2.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Hephaestus,
        workflowName: "code-review",
        storyKey: story03,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, story03, StoryStatus.Done);
      return okResult("review:0-3");
    });

    const orchestrator2 = new SprintOrchestrator(
      stateRepo2,
      runner2,
      runState2,
      logger,
      config,
    );
    const second = await orchestrator2.resumeSprint();

    expect(second.status).toBe("complete");
    expect(second.completed).toBe(1);
    expect(second.failed).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.results.map((r) => r.storyKey)).toEqual([story03]);

    expect(runner2.callHistory[0]?.message.includes("create-story")).toBe(false);
  });

  test("max retries exceeded", async () => {
    const storyKey = "0-1-stuck-in-review";
    await writeSprintStatusYaml({
      yamlPath,
      storyStatuses: [{ storyKey, status: StoryStatus.ReadyForDev }],
    });

    const stateRepo = new SprintStatusManager(yamlPath);
    const runState = new RunStateStore(runStatePath);
    const logger = new StubLogger();
    const config = makeConfig(projectDir, { maxRetries: 2 });
    const runner = new IntegrationMockRunner();

    const devHandler = async (call: RunOptions, id: string) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "dev-story",
        storyKey,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.Review);
      return okResult(id);
    };

    const reviewNotDoneHandler = async (call: RunOptions, id: string) => {
      expectRunCall(call, {
        agent: AgentType.Hephaestus,
        workflowName: "code-review",
        storyKey,
        projectDir,
        timeout: config.timeout,
      });
      await updateYamlStatus(yamlPath, storyKey, StoryStatus.InProgress);
      return okResult(id);
    };

    runner.addHandler((call) => devHandler(call, "dev-0"));
    runner.addHandler((call) => reviewNotDoneHandler(call, "review-0"));
    runner.addHandler((call) => devHandler(call, "dev-1"));
    runner.addHandler((call) => reviewNotDoneHandler(call, "review-1"));
    runner.addHandler((call) => devHandler(call, "dev-2"));
    runner.addHandler((call) => reviewNotDoneHandler(call, "review-2"));

    const orchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
    const result = await orchestrator.runSprint();

    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.status).toBe("paused");
    expect(runner.callHistory).toHaveLength(6);

    const finalStatus = await stateRepo.readStatus();
    expect(finalStatus.development_status[storyKey]).toBe(StoryStatus.NeedsHumanIntervention);
  });

  test("sprint planning required", async () => {
    await copyFile(join(process.cwd(), "tests/fixtures/sprint-status-empty.yaml"), yamlPath);

    const stateRepo = new SprintStatusManager(yamlPath);
    const runState = new RunStateStore(runStatePath);
    const logger = new StubLogger();
    const config = makeConfig(projectDir);
    const runner = new IntegrationMockRunner();

    const story1 = "0-1-planned-story-a";
    const story2 = "0-2-planned-story-b";

    runner.addHandler(async (call) => {
      expectRunCall(call, {
        agent: AgentType.Sisyphus,
        workflowName: "sprint-planning",
        projectDir,
        timeout: config.timeout,
      });

      await updateYamlStatus(yamlPath, story1, StoryStatus.Backlog);
      await updateYamlStatus(yamlPath, story2, StoryStatus.Backlog);
      return okResult("planning");
    });

    runner.addHandler(async (call) => {
      await updateYamlStatus(yamlPath, story1, StoryStatus.ReadyForDev);
      return okResult("create:1");
    });
    runner.addHandler(async (call) => {
      await updateYamlStatus(yamlPath, story1, StoryStatus.Review);
      return okResult("dev:1");
    });
    runner.addHandler(async (call) => {
      await updateYamlStatus(yamlPath, story1, StoryStatus.Done);
      return okResult("review:1");
    });

    runner.addHandler(async (call) => {
      await updateYamlStatus(yamlPath, story2, StoryStatus.ReadyForDev);
      return okResult("create:2");
    });
    runner.addHandler(async (call) => {
      await updateYamlStatus(yamlPath, story2, StoryStatus.Review);
      return okResult("dev:2");
    });
    runner.addHandler(async (call) => {
      await updateYamlStatus(yamlPath, story2, StoryStatus.Done);
      return okResult("review:2");
    });

    const orchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
    const result = await orchestrator.runSprint();

    expect(runner.callHistory[0]?.agent).toBe(AgentType.Sisyphus);
    expect(runner.callHistory[0]?.message).toContain("sprint-planning");

    expect(result.status).toBe("complete");
    expect(result.totalStories).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
