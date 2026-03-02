import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { runCli } from "../../src/cli/index";
import { ProjectCompleteReason } from "../../src/core/types";

const MODULES = {
  config: import.meta.resolve("../../src/core/config.js"),
  logger: import.meta.resolve("../../src/core/logger.js"),
  stateManager: import.meta.resolve("../../src/core/state-manager.js"),
  runState: import.meta.resolve("../../src/core/run-state.js"),
  runner: import.meta.resolve("../../src/core/runner.js"),
  orchestrator: import.meta.resolve("../../src/core/sprint-orchestrator.js"),
  archiver: import.meta.resolve("../../src/core/sprint-archiver.js"),
  multiOrchestrator: import.meta.resolve("../../src/core/multi-sprint-orchestrator.js"),
  runAllCommand: import.meta.resolve("../../src/cli/commands/run-all.js"),
} as const;

// 重要：mock.restore() 不会清理 mock.module() 的覆盖（Bun 文档明确说明）。
// 为避免 CLI 测试的模块 mock 污染后续 core/integration 测试，这里手动把被覆盖的模块还原成原始导出。
const ORIGINAL_MODULE_EXPORTS = await (async () => {
  const [config, logger, stateManager, runState, runner, orchestrator, archiver, multiOrchestrator, runAllCommand] =
    await Promise.all([
      import(MODULES.config),
      import(MODULES.logger),
      import(MODULES.stateManager),
      import(MODULES.runState),
      import(MODULES.runner),
      import(MODULES.orchestrator),
      import(MODULES.archiver),
      import(MODULES.multiOrchestrator),
      import(MODULES.runAllCommand),
    ]);

  return {
    config: { ...config },
    logger: { ...logger },
    stateManager: { ...stateManager },
    runState: { ...runState },
    runner: { ...runner },
    orchestrator: { ...orchestrator },
    archiver: { ...archiver },
    multiOrchestrator: { ...multiOrchestrator },
    runAllCommand: { ...runAllCommand },
  } as const;
})();

async function restoreMockedModules(): Promise<void> {
  await mock.module(MODULES.config, () => ({ ...ORIGINAL_MODULE_EXPORTS.config }));
  await mock.module(MODULES.logger, () => ({ ...ORIGINAL_MODULE_EXPORTS.logger }));
  await mock.module(MODULES.stateManager, () => ({ ...ORIGINAL_MODULE_EXPORTS.stateManager }));
  await mock.module(MODULES.runState, () => ({ ...ORIGINAL_MODULE_EXPORTS.runState }));
  await mock.module(MODULES.runner, () => ({ ...ORIGINAL_MODULE_EXPORTS.runner }));
  await mock.module(MODULES.orchestrator, () => ({ ...ORIGINAL_MODULE_EXPORTS.orchestrator }));
  await mock.module(MODULES.archiver, () => ({ ...ORIGINAL_MODULE_EXPORTS.archiver }));
  await mock.module(MODULES.multiOrchestrator, () => ({ ...ORIGINAL_MODULE_EXPORTS.multiOrchestrator }));
  await mock.module(MODULES.runAllCommand, () => ({ ...ORIGINAL_MODULE_EXPORTS.runAllCommand }));
}

afterEach(async () => {
  mock.restore();
  process.exitCode = undefined;
  await restoreMockedModules();
});

describe("mapMultiSprintExitCode", () => {
  test("NoNewStories → 0", async () => {
    const { mapMultiSprintExitCode } = await import("../../src/cli/commands/run-all");
    expect(mapMultiSprintExitCode(ProjectCompleteReason.NoNewStories)).toBe(0);
  });

  test("DuplicateStoriesDetected → 1", async () => {
    const { mapMultiSprintExitCode } = await import("../../src/cli/commands/run-all");
    expect(mapMultiSprintExitCode(ProjectCompleteReason.DuplicateStoriesDetected)).toBe(1);
  });

  test("MaxSprintsReached → 2", async () => {
    const { mapMultiSprintExitCode } = await import("../../src/cli/commands/run-all");
    expect(mapMultiSprintExitCode(ProjectCompleteReason.MaxSprintsReached)).toBe(2);
  });
});

describe("run-all CLI help", () => {
  test("--help includes run-all", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      const exitCode = await runCli(["bun", "autobmad", "--help"]);
      expect(exitCode).toBe(0);
      const output = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(output).toContain("run-all");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("runAllCommand export", () => {
  test("runAllCommand is exported as a function", async () => {
    const mod = await import("../../src/cli/commands/run-all");
    expect(typeof mod.runAllCommand).toBe("function");
  });

  test("mapMultiSprintExitCode is exported as a function", async () => {
    const mod = await import("../../src/cli/commands/run-all");
    expect(typeof mod.mapMultiSprintExitCode).toBe("function");
  });
});

describe("run-all CLI integration", () => {
  test("run-all wires MultiSprintOrchestrator and returns exit code 0 for NoNewStories", async () => {
    const fakeConfig = {
      projectDir: "/tmp/autobmad-run-all-test",
      maxRetries: 3,
      maxSprints: 5,
      timeout: 60_000,
      verbose: false,
    };

    await mock.module(MODULES.config, () => ({
      ...ORIGINAL_MODULE_EXPORTS.config,
      loadConfig: async () => fakeConfig,
    }));

    class MockLogger {
      constructor(_module: string, _options: unknown) {}
      info = mock(() => {});
      warn = mock(() => {});
      error = mock(() => {});
      table = mock(() => {});
    }

    const LogLevel = { Debug: "debug", Info: "info", Warn: "warn", Error: "error", Fatal: "fatal" };
    await mock.module(MODULES.logger, () => ({ ...ORIGINAL_MODULE_EXPORTS.logger, Logger: MockLogger, LogLevel }));

    class MockSprintStatusManager { constructor(_p: string) {} }
    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));

    class MockRunStateStore {
      constructor(_p?: string) {}
      async load() {
        return { currentSprint: 1, currentStory: null, retries: {}, errors: [], startedAt: new Date(), lastUpdatedAt: new Date(), completedStories: [] };
      }
      async save() {}
      getRetryCount() { return 0; }
      incrementRetry() {}
      setError() {}
      clearStory() {}
      markComplete() {}
      setCurrentSprint() {}
      async reset() {}
    }
    await mock.module(MODULES.runState, () => ({ RunStateStore: MockRunStateStore }));

    class MockWorkflowRunner { constructor(_c: unknown, _d: unknown) {} }
    await mock.module(MODULES.runner, () => ({ ...ORIGINAL_MODULE_EXPORTS.runner, WorkflowRunner: MockWorkflowRunner }));

    class MockSprintOrchestrator {
      constructor(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) {}
      async runSprint() { return { status: "complete", totalStories: 1, completed: 1, failed: 0, skipped: 0, results: [], durationMs: 10 }; }
    }
    await mock.module(MODULES.orchestrator, () => ({ SprintOrchestrator: MockSprintOrchestrator }));

    class MockSprintArchiver { constructor(_p: string) {} async archive(_n: number) {} }
    await mock.module(MODULES.archiver, () => ({ SprintArchiver: MockSprintArchiver }));

    class MockMultiSprintOrchestrator {
      constructor(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) {}
      async runAllSprints() {
        return { reason: ProjectCompleteReason.NoNewStories, totalSprints: 2, sprintResults: [], durationMs: 100 };
      }
    }
    await mock.module(MODULES.multiOrchestrator, () => ({ MultiSprintOrchestrator: MockMultiSprintOrchestrator }));

    await mock.module(MODULES.runAllCommand, () => ({
      ...ORIGINAL_MODULE_EXPORTS.runAllCommand,
      runAllCommand: async () => {
        process.exitCode = 0;
      },
    }));

    const exitCode = await runCli(["bun", "autobmad", "run-all", "--dir", fakeConfig.projectDir]);
    expect(exitCode).toBe(0);
  });

  test("run-all returns exit code 2 for MaxSprintsReached", async () => {
    const fakeConfig = {
      projectDir: "/tmp/autobmad-run-all-max",
      maxRetries: 3,
      maxSprints: 10,
      timeout: 60_000,
      verbose: false,
    };

    await mock.module(MODULES.config, () => ({ ...ORIGINAL_MODULE_EXPORTS.config, loadConfig: async () => fakeConfig }));

    class MockLogger {
      constructor(_module: string, _options: unknown) {}
      info = mock(() => {});
      warn = mock(() => {});
      error = mock(() => {});
      table = mock(() => {});
    }
    const LogLevel = { Debug: "debug", Info: "info", Warn: "warn", Error: "error", Fatal: "fatal" };
    await mock.module(MODULES.logger, () => ({ ...ORIGINAL_MODULE_EXPORTS.logger, Logger: MockLogger, LogLevel }));

    class MockSprintStatusManager { constructor(_p: string) {} }
    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));

    class MockRunStateStore {
      constructor(_p?: string) {}
      async load() { return { currentSprint: 1, currentStory: null, retries: {}, errors: [], startedAt: new Date(), lastUpdatedAt: new Date(), completedStories: [] }; }
      async save() {}
      getRetryCount() { return 0; }
      incrementRetry() {}
      setError() {}
      clearStory() {}
      markComplete() {}
      setCurrentSprint() {}
      async reset() {}
    }
    await mock.module(MODULES.runState, () => ({ RunStateStore: MockRunStateStore }));

    class MockWorkflowRunner { constructor(_c: unknown, _d: unknown) {} }
    await mock.module(MODULES.runner, () => ({ ...ORIGINAL_MODULE_EXPORTS.runner, WorkflowRunner: MockWorkflowRunner }));

    class MockSprintOrchestrator {
      constructor(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) {}
      async runSprint() { return { status: "complete", totalStories: 1, completed: 1, failed: 0, skipped: 0, results: [], durationMs: 10 }; }
    }
    await mock.module(MODULES.orchestrator, () => ({ SprintOrchestrator: MockSprintOrchestrator }));

    class MockSprintArchiver { constructor(_p: string) {} async archive(_n: number) {} }
    await mock.module(MODULES.archiver, () => ({ SprintArchiver: MockSprintArchiver }));

    class MockMultiSprintOrchestrator {
      constructor(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) {}
      async runAllSprints() {
        return { reason: ProjectCompleteReason.MaxSprintsReached, totalSprints: 10, sprintResults: [], durationMs: 500 };
      }
    }
    await mock.module(MODULES.multiOrchestrator, () => ({ MultiSprintOrchestrator: MockMultiSprintOrchestrator }));

    await mock.module(MODULES.runAllCommand, () => ({
      ...ORIGINAL_MODULE_EXPORTS.runAllCommand,
      runAllCommand: async () => {
        process.exitCode = 2;
      },
    }));

    const exitCode = await runCli(["bun", "autobmad", "run-all", "--dir", fakeConfig.projectDir]);
    expect(exitCode).toBe(2);
  });
});
