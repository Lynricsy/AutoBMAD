import { describe, test, expect, afterEach, spyOn, mock } from "bun:test";
import { runCli } from "../../src/cli/index";

const MODULES = {
  config: import.meta.resolve("../../src/core/config.js"),
  logger: import.meta.resolve("../../src/core/logger.js"),
  stateManager: import.meta.resolve("../../src/core/state-manager.js"),
  runState: import.meta.resolve("../../src/core/run-state.js"),
  runner: import.meta.resolve("../../src/core/runner.js"),
  orchestrator: import.meta.resolve("../../src/core/sprint-orchestrator.js"),
} as const;

afterEach(async () => {
  // mock.restore() does NOT reset mock.module() overrides (Bun documented behavior).
  // Explicitly restore all mocked modules to prevent cross-file leakage in CI.
  await mock.module(MODULES.config, () => import("../../src/core/config.js"));
  await mock.module(MODULES.logger, () => import("../../src/core/logger.js"));
  await mock.module(MODULES.stateManager, () => import("../../src/core/state-manager.js"));
  await mock.module(MODULES.runState, () => import("../../src/core/run-state.js"));
  await mock.module(MODULES.runner, () => import("../../src/core/runner.js"));
  await mock.module(MODULES.orchestrator, () => import("../../src/core/sprint-orchestrator.js"));
  mock.restore();
  process.exitCode = undefined;
});

describe("AutoBMAD CLI", () => {
  test("--help prints help text", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await runCli(["bun", "autobmad", "--help"]);

    expect(exitCode).toBe(0);
    expect(logSpy.mock.calls.length).toBeGreaterThan(0);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Commands:");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("start");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("resume");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("status");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("reset");

    logSpy.mockRestore();
  });

  test("start --dir wires config/logger/state/runner/orchestrator", async () => {
    const calls = {
      loadConfig: [] as Array<string[] | undefined>,
      logger: [] as Array<{ module: string; options: any }>,
      statusManager: [] as string[],
      runState: [] as string[],
      workflowRunner: [] as Array<{ config: any; deps: any }>,
      orchestrator: [] as any[],
    };

    const fakeConfig = {
      projectDir: "/tmp/autobmad-cli-test",
      maxRetries: 3,
      timeout: 123_000,
      verbose: true,
    };

    await mock.module(MODULES.config, () => ({
      loadConfig: async (argv?: string[]) => {
        calls.loadConfig.push(argv);
        return fakeConfig;
      },
    }));

    class MockLogger {
      constructor(module: string, options: any) {
        calls.logger.push({ module, options });
      }
      info = mock(() => {});
      warn = mock(() => {});
      error = mock(() => {});
      table = mock(() => {});
    }

    const LogLevel = {
      Debug: "debug",
      Info: "info",
      Warn: "warn",
      Error: "error",
      Fatal: "fatal",
    };

    await mock.module(MODULES.logger, () => ({ Logger: MockLogger, LogLevel }));

    class MockSprintStatusManager {
      constructor(statusFilePath: string) {
        calls.statusManager.push(statusFilePath);
      }
    }

    await mock.module(MODULES.stateManager, () => ({ SprintStatusManager: MockSprintStatusManager }));

    class MockRunStateStore {
      constructor(statePath?: string) {
        calls.runState.push(statePath ?? "");
      }
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
      getRetryCount() {
        return 0;
      }
      incrementRetry() {}
      setError() {}
      clearStory() {}
      markComplete() {}
      async reset() {}
    }

    await mock.module(MODULES.runState, () => ({ RunStateStore: MockRunStateStore }));

    class MockWorkflowRunner {
      constructor(config: any, deps: any) {
        calls.workflowRunner.push({ config, deps });
      }
    }

    await mock.module(MODULES.runner, () => ({ WorkflowRunner: MockWorkflowRunner }));

    class MockSprintOrchestrator {
      constructor(stateRepo: any, runner: any, runState: any, logger: any, config: any) {
        calls.orchestrator.push({ stateRepo, runner, runState, logger, config });
      }
      async runSprint() {
        return {
          status: "complete",
          totalStories: 1,
          completed: 1,
          failed: 0,
          skipped: 0,
          results: [],
          durationMs: 10,
        };
      }
    }

    await mock.module(MODULES.orchestrator, () => ({ SprintOrchestrator: MockSprintOrchestrator }));

    const exitCode = await runCli([
      "bun",
      "autobmad",
      "start",
      "--dir",
      fakeConfig.projectDir,
      "--verbose",
    ]);

    expect(exitCode).toBe(0);

    expect(calls.loadConfig).toHaveLength(1);
    expect(calls.loadConfig[0]).toEqual([
      "bun",
      "autobmad",
      "start",
      "--dir",
      fakeConfig.projectDir,
      "--verbose",
    ]);

    expect(calls.logger).toHaveLength(1);
    expect(calls.logger[0]?.module).toBe("cli");
    expect(calls.logger[0]?.options.logDir).toBe(`${fakeConfig.projectDir}/.autobmad-logs`);
    expect(calls.logger[0]?.options.level).toBe(LogLevel.Debug);

    expect(calls.statusManager).toEqual([
      `${fakeConfig.projectDir}/_bmad-output/implementation-artifacts/sprint-status.yaml`,
    ]);
    expect(calls.runState).toEqual([`${fakeConfig.projectDir}/.autobmad-state.json`]);
    expect(calls.workflowRunner).toHaveLength(1);
    expect(calls.workflowRunner[0]?.config.timeout).toBe(fakeConfig.timeout);

    expect(calls.orchestrator).toHaveLength(1);
    expect(calls.orchestrator[0]?.config).toEqual(fakeConfig);
  });

  test("status --dir prints status table", async () => {
    const tableCalls: Array<{ headers: string[]; rows: string[][] }> = [];

    class MockLogger {
      constructor(_module: string, _options: any) {}
      debug = mock(() => {});
      info = mock(() => {});
      warn = mock(() => {});
      error = mock(() => {});
      table = mock((headers: string[], rows: string[][]) => {
        tableCalls.push({ headers, rows });
      });
    }

    const LogLevel = {
      Debug: "debug",
      Info: "info",
      Warn: "warn",
      Error: "error",
      Fatal: "fatal",
    };

    await mock.module(MODULES.logger, () => ({ Logger: MockLogger, LogLevel }));

    class MockSprintOrchestrator {
      constructor(_stateRepo: any, _runner: any, _runState: any, _logger: any, _config: any) {}
      async getSprintStatus() {
        return {
          totalStories: 3,
          byStatus: {
            backlog: 1,
            "ready-for-dev": 1,
            "in-progress": 0,
            review: 0,
            done: 1,
            "needs-human-intervention": 0,
          },
        };
      }
    }

    await mock.module(MODULES.orchestrator, () => ({ SprintOrchestrator: MockSprintOrchestrator }));

    const exitCode = await runCli(["bun", "autobmad", "status", "--dir", "/tmp/x"]);

    expect(exitCode).toBe(0);
    expect(tableCalls).toHaveLength(1);
    expect(tableCalls[0]?.headers).toEqual(["status", "count"]);
    expect(tableCalls[0]?.rows).toContainEqual(["backlog", "1"]);
    expect(tableCalls[0]?.rows).toContainEqual(["done", "1"]);
  });

  test("reset --dir calls RunStateStore.reset", async () => {
    const calls = {
      constructed: [] as string[],
      reset: 0,
      logs: [] as string[],
    };

    class MockRunStateStore {
      constructor(statePath?: string) {
        calls.constructed.push(statePath ?? "");
      }
      async reset() {
        calls.reset += 1;
      }
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
      getRetryCount() {
        return 0;
      }
      incrementRetry() {}
      setError() {}
      clearStory() {}
      markComplete() {}
    }

    await mock.module(MODULES.runState, () => ({ RunStateStore: MockRunStateStore }));

    const logSpy = spyOn(console, "log").mockImplementation((msg?: any) => {
      calls.logs.push(String(msg ?? ""));
    });

    const exitCode = await runCli(["bun", "autobmad", "reset", "--dir", "/tmp/reset-proj"]);

    expect(exitCode).toBe(0);
    expect(calls.constructed).toEqual(["/tmp/reset-proj/.autobmad-state.json"]);
    expect(calls.reset).toBe(1);
    expect(calls.logs.join("\n")).toContain("Reset run state");

    logSpy.mockRestore();
  });
});
