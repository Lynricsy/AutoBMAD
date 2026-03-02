import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { runCli } from "../../src/cli/index.js";
import { ProjectCompleteReason } from "../../src/core/types.js";

const MODULES = {
  config: import.meta.resolve("../../src/core/config.js"),
  logger: import.meta.resolve("../../src/core/logger.js"),
  stateManager: import.meta.resolve("../../src/core/state-manager.js"),
  runState: import.meta.resolve("../../src/core/run-state.js"),
  runner: import.meta.resolve("../../src/core/runner.js"),
  orchestrator: import.meta.resolve("../../src/core/sprint-orchestrator.js"),
  archiver: import.meta.resolve("../../src/core/sprint-archiver.js"),
  multiOrchestrator: import.meta.resolve("../../src/core/multi-sprint-orchestrator.js"),
} as const;

const TEST_DIR = "/tmp/autobmad-resume-test-dir";
const fakeConfig = {
  projectDir: TEST_DIR,
  maxRetries: 3,
  maxSprints: 10,
  timeout: 30_000,
  verbose: false,
};

const LogLevel = {
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "fatal",
};

class MockLogger {
  constructor(_module: string, _options: unknown) {}
  info = mock(() => {});
  warn = mock(() => {});
  error = mock(() => {});
  table = mock(() => {});
}

class MockSprintStatusManager {
  constructor(_statusFilePath: string) {}
  async readStatus() {
    return { generated: "", project: "", project_key: "", tracking_system: "", story_location: "", development_status: {} };
  }
  async updateStatus() {}
  async getNextStory() { return null; }
  async getAllStories() { return new Map<string, string>(); }
  async isSprintComplete() { return true; }
}

class MockWorkflowRunner {
  constructor(_config: unknown, _deps: unknown) {}
}

afterEach(() => {
  mock.restore();
  process.exitCode = undefined;
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

describe("resumeCommand - no state file", () => {
  test("exits with code 1 when no run state exists", async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    await mock.module(MODULES.config, () => ({
      loadConfig: async () => fakeConfig,
    }));
    await mock.module(MODULES.logger, () => ({ Logger: MockLogger, LogLevel }));
    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));
    await mock.module(MODULES.runState, () => ({
      RunStateStore: class {
        constructor(_path: string) {}
        async load() {
          return {
            currentSprint: 1, currentStory: null, retries: {}, errors: [],
            startedAt: new Date(), lastUpdatedAt: new Date(), completedStories: [],
          };
        }
        async save() {}
        getRetryCount() { return 0; }
        incrementRetry() {}
        setError() {}
        clearStory() {}
        markComplete() {}
        setCurrentSprint() {}
        async reset() {}
      },
    }));
    await mock.module(MODULES.runner, () => ({ WorkflowRunner: MockWorkflowRunner }));
    await mock.module(MODULES.orchestrator, () => ({
      SprintOrchestrator: class {
        constructor() {}
        resumeSprint = mock(async () => ({ status: "complete", totalStories: 0, completed: 0, failed: 0, skipped: 0, results: [], durationMs: 0 }));
        runSprint = mock(async () => ({ status: "complete", totalStories: 0, completed: 0, failed: 0, skipped: 0, results: [], durationMs: 0 }));
      },
    }));
    await mock.module(MODULES.archiver, () => ({
      SprintArchiver: class { constructor() {} async archive() {} },
    }));
    await mock.module(MODULES.multiOrchestrator, () => ({
      MultiSprintOrchestrator: class {
        constructor() {}
        runAllSprints = mock(async () => ({ reason: "no-new-stories", totalSprints: 0, sprintResults: [], durationMs: 0 }));
      },
    }));

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    const exitCode = await runCli([
      "bun", "autobmad", "resume", "--dir", "/nonexistent-no-state-path-xyz",
    ]);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});

describe("resumeCommand - single-sprint path (currentSprint=1)", () => {
  test("uses SprintOrchestrator.resumeSprint() when currentSprint=1", async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const resumeSprintMock = mock(async () => ({
      status: "complete" as const,
      totalStories: 2,
      completed: 2,
      failed: 0,
      skipped: 0,
      results: [],
      durationMs: 100,
    }));

    const runAllSprintsMock = mock(async () => ({
      reason: ProjectCompleteReason.NoNewStories,
      totalSprints: 1,
      sprintResults: [],
      durationMs: 100,
    }));

    await mock.module(MODULES.config, () => ({
      loadConfig: async () => fakeConfig,
    }));
    await mock.module(MODULES.logger, () => ({ Logger: MockLogger, LogLevel }));
    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));
    await mock.module(MODULES.runState, () => ({
      RunStateStore: class {
        constructor(_path: string) {}
        async load() {
          return {
            currentSprint: 1,
            currentStory: null,
            retries: {},
            errors: [],
            startedAt: new Date(),
            lastUpdatedAt: new Date(),
            completedStories: [],
          };
        }
        async save() {}
        getRetryCount() { return 0; }
        incrementRetry() {}
        setError() {}
        clearStory() {}
        markComplete() {}
        setCurrentSprint() {}
        async reset() {}
      },
    }));
    await mock.module(MODULES.runner, () => ({ WorkflowRunner: MockWorkflowRunner }));
    await mock.module(MODULES.orchestrator, () => ({
      SprintOrchestrator: class {
        constructor() {}
        resumeSprint = resumeSprintMock;
        runSprint = mock(async () => ({ status: "complete", totalStories: 0, completed: 0, failed: 0, skipped: 0, results: [], durationMs: 0 }));
      },
    }));
    await mock.module(MODULES.archiver, () => ({
      SprintArchiver: class {
        constructor() {}
        async archive() {}
      },
    }));
    await mock.module(MODULES.multiOrchestrator, () => ({
      MultiSprintOrchestrator: class {
        constructor() {}
        runAllSprints = runAllSprintsMock;
      },
    }));

    const origFile = Bun.file;
    (Bun as unknown as Record<string, unknown>).file = (path: string) => {
      if (typeof path === "string" && path.endsWith(".autobmad-state.json")) {
        return { exists: async () => true };
      }
      return origFile(path);
    };

    const exitCode = await runCli([
      "bun", "autobmad", "resume", "--dir", TEST_DIR,
    ]);

    (Bun as unknown as Record<string, unknown>).file = origFile;

    expect(resumeSprintMock).toHaveBeenCalledTimes(1);
    expect(runAllSprintsMock).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });
});

describe("resumeCommand - multi-sprint path (currentSprint>1)", () => {
  test("uses MultiSprintOrchestrator.runAllSprints() when currentSprint=3", async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const resumeSprintMock = mock(async () => ({
      status: "complete" as const,
      totalStories: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      results: [],
      durationMs: 0,
    }));

    const runAllSprintsMock = mock(async () => ({
      reason: ProjectCompleteReason.NoNewStories,
      totalSprints: 3,
      sprintResults: [],
      durationMs: 200,
    }));

    await mock.module(MODULES.config, () => ({
      loadConfig: async () => fakeConfig,
    }));
    await mock.module(MODULES.logger, () => ({ Logger: MockLogger, LogLevel }));
    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));
    await mock.module(MODULES.runState, () => ({
      RunStateStore: class {
        constructor(_path: string) {}
        async load() {
          return {
            currentSprint: 3,
            currentStory: null,
            retries: {},
            errors: [],
            startedAt: new Date(),
            lastUpdatedAt: new Date(),
            completedStories: [],
          };
        }
        async save() {}
        getRetryCount() { return 0; }
        incrementRetry() {}
        setError() {}
        clearStory() {}
        markComplete() {}
        setCurrentSprint() {}
        async reset() {}
      },
    }));
    await mock.module(MODULES.runner, () => ({ WorkflowRunner: MockWorkflowRunner }));
    await mock.module(MODULES.orchestrator, () => ({
      SprintOrchestrator: class {
        constructor() {}
        resumeSprint = resumeSprintMock;
        runSprint = mock(async () => ({ status: "complete", totalStories: 0, completed: 0, failed: 0, skipped: 0, results: [], durationMs: 0 }));
      },
    }));
    await mock.module(MODULES.archiver, () => ({
      SprintArchiver: class {
        constructor() {}
        async archive() {}
      },
    }));
    await mock.module(MODULES.multiOrchestrator, () => ({
      MultiSprintOrchestrator: class {
        constructor() {}
        runAllSprints = runAllSprintsMock;
      },
    }));

    const origFile = Bun.file;
    (Bun as unknown as Record<string, unknown>).file = (path: string) => {
      if (typeof path === "string" && path.endsWith(".autobmad-state.json")) {
        return { exists: async () => true };
      }
      return origFile(path);
    };

    const exitCode = await runCli([
      "bun", "autobmad", "resume", "--dir", TEST_DIR,
    ]);

    (Bun as unknown as Record<string, unknown>).file = origFile;

    expect(runAllSprintsMock).toHaveBeenCalledTimes(1);
    expect(resumeSprintMock).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  test("maps MaxSprintsReached to exit code 2", async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const runAllSprintsMock = mock(async () => ({
      reason: ProjectCompleteReason.MaxSprintsReached,
      totalSprints: 10,
      sprintResults: [],
      durationMs: 500,
    }));

    await mock.module(MODULES.config, () => ({
      loadConfig: async () => fakeConfig,
    }));
    await mock.module(MODULES.logger, () => ({ Logger: MockLogger, LogLevel }));
    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));
    await mock.module(MODULES.runState, () => ({
      RunStateStore: class {
        constructor(_path: string) {}
        async load() {
          return {
            currentSprint: 2,
            currentStory: null,
            retries: {},
            errors: [],
            startedAt: new Date(),
            lastUpdatedAt: new Date(),
            completedStories: [],
          };
        }
        async save() {}
        getRetryCount() { return 0; }
        incrementRetry() {}
        setError() {}
        clearStory() {}
        markComplete() {}
        setCurrentSprint() {}
        async reset() {}
      },
    }));
    await mock.module(MODULES.runner, () => ({ WorkflowRunner: MockWorkflowRunner }));
    await mock.module(MODULES.orchestrator, () => ({
      SprintOrchestrator: class {
        constructor() {}
        resumeSprint = mock(async () => ({ status: "complete", totalStories: 0, completed: 0, failed: 0, skipped: 0, results: [], durationMs: 0 }));
        runSprint = mock(async () => ({ status: "complete", totalStories: 0, completed: 0, failed: 0, skipped: 0, results: [], durationMs: 0 }));
      },
    }));
    await mock.module(MODULES.archiver, () => ({
      SprintArchiver: class {
        constructor() {}
        async archive() {}
      },
    }));
    await mock.module(MODULES.multiOrchestrator, () => ({
      MultiSprintOrchestrator: class {
        constructor() {}
        runAllSprints = runAllSprintsMock;
      },
    }));

    const origFile = Bun.file;
    (Bun as unknown as Record<string, unknown>).file = (path: string) => {
      if (typeof path === "string" && path.endsWith(".autobmad-state.json")) {
        return { exists: async () => true };
      }
      return origFile(path);
    };

    const exitCode = await runCli([
      "bun", "autobmad", "resume", "--dir", TEST_DIR,
    ]);

    (Bun as unknown as Record<string, unknown>).file = origFile;

    expect(exitCode).toBe(2);
  });
});

describe("resumeCommand - backward compat (currentSprint undefined)", () => {
  test("old state file missing currentSprint defaults to single-sprint path", async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const resumeSprintMock = mock(async () => ({
      status: "complete" as const,
      totalStories: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      results: [],
      durationMs: 50,
    }));

    const runAllSprintsMock = mock(async () => ({
      reason: ProjectCompleteReason.NoNewStories,
      totalSprints: 1,
      sprintResults: [],
      durationMs: 50,
    }));

    await mock.module(MODULES.config, () => ({
      loadConfig: async () => fakeConfig,
    }));
    await mock.module(MODULES.logger, () => ({ Logger: MockLogger, LogLevel }));
    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));
    await mock.module(MODULES.runState, () => ({
      RunStateStore: class {
        constructor(_path: string) {}
        async load() {
          return {
            currentStory: null,
            retries: {},
            errors: [],
            startedAt: new Date(),
            lastUpdatedAt: new Date(),
            completedStories: [],
          };
        }
        async save() {}
        getRetryCount() { return 0; }
        incrementRetry() {}
        setError() {}
        clearStory() {}
        markComplete() {}
        setCurrentSprint() {}
        async reset() {}
      },
    }));
    await mock.module(MODULES.runner, () => ({ WorkflowRunner: MockWorkflowRunner }));
    await mock.module(MODULES.orchestrator, () => ({
      SprintOrchestrator: class {
        constructor() {}
        resumeSprint = resumeSprintMock;
        runSprint = mock(async () => ({ status: "complete", totalStories: 0, completed: 0, failed: 0, skipped: 0, results: [], durationMs: 0 }));
      },
    }));
    await mock.module(MODULES.archiver, () => ({
      SprintArchiver: class {
        constructor() {}
        async archive() {}
      },
    }));
    await mock.module(MODULES.multiOrchestrator, () => ({
      MultiSprintOrchestrator: class {
        constructor() {}
        runAllSprints = runAllSprintsMock;
      },
    }));

    const origFile = Bun.file;
    (Bun as unknown as Record<string, unknown>).file = (path: string) => {
      if (typeof path === "string" && path.endsWith(".autobmad-state.json")) {
        return { exists: async () => true };
      }
      return origFile(path);
    };

    const exitCode = await runCli([
      "bun", "autobmad", "resume", "--dir", TEST_DIR,
    ]);

    (Bun as unknown as Record<string, unknown>).file = origFile;

    expect(resumeSprintMock).toHaveBeenCalledTimes(1);
    expect(runAllSprintsMock).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });
});
