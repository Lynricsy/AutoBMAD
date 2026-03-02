import { mock } from "bun:test";
import { runCli } from "../../src/cli/index";

const MODULES = {
  config: import.meta.resolve("../../src/core/config.js"),
  logger: import.meta.resolve("../../src/core/logger.js"),
  stateManager: import.meta.resolve("../../src/core/state-manager.js"),
  runState: import.meta.resolve("../../src/core/run-state.js"),
  runner: import.meta.resolve("../../src/core/runner.js"),
  orchestrator: import.meta.resolve("../../src/core/sprint-orchestrator.js"),
} as const;

type HarnessOk<T> = {
  ok: true;
  case: string;
  stdout: string;
  stderr: string;
  data: T;
};

type HarnessErr = {
  ok: false;
  case: string;
  stdout: string;
  stderr: string;
  error: { message: string; stack?: string };
};

function errorToJson(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

async function captureIO<T>(fn: () => Promise<T>): Promise<{ stdout: string; stderr: string; result: T }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);

  (process.stdout.write as unknown) = ((chunk: unknown): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  (process.stderr.write as unknown) = ((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return {
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      result,
    };
  } finally {
    (process.stdout.write as unknown) = outWrite;
    (process.stderr.write as unknown) = errWrite;
  }
}

async function caseHelp(): Promise<{ exitCode: number }> {
  process.exitCode = undefined;
  const exitCode = await runCli(["bun", "autobmad", "--help"]);
  return { exitCode };
}

async function caseStartWiring(): Promise<{
  exitCode: number;
  calls: {
    loadConfig: Array<string[] | undefined>;
    logger: Array<{ module: string; options: any }>;
    statusManager: string[];
    runState: string[];
    workflowRunner: Array<{ config: any; deps: any }>;
    orchestrator: any[];
  };
}> {
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
    maxSprints: 10,
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
        currentSprint: 1,
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

  process.exitCode = undefined;
  const exitCode = await runCli([
    "bun",
    "autobmad",
    "start",
    "--dir",
    fakeConfig.projectDir,
    "--verbose",
  ]);

  return { exitCode, calls };
}

async function caseStatusTable(): Promise<{
  exitCode: number;
  tableCalls: Array<{ headers: string[]; rows: string[][] }>;
}> {
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

  process.exitCode = undefined;
  const exitCode = await runCli(["bun", "autobmad", "status", "--dir", "/tmp/x"]);
  return { exitCode, tableCalls };
}

async function caseReset(): Promise<{
  exitCode: number;
  calls: {
    constructed: string[];
    reset: number;
  };
}> {
  const calls = {
    constructed: [] as string[],
    reset: 0,
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
        currentSprint: 1,
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

  process.exitCode = undefined;
  const exitCode = await runCli(["bun", "autobmad", "reset", "--dir", "/tmp/reset-proj"]);
  return { exitCode, calls };
}

async function runCase(caseName: string): Promise<any> {
  switch (caseName) {
    case "help":
      return await caseHelp();
    case "start-wiring":
      return await caseStartWiring();
    case "status-table":
      return await caseStatusTable();
    case "reset":
      return await caseReset();
    default:
      throw new Error(`Unknown harness case: ${caseName}`);
  }
}

const caseName = process.argv[2];
if (!caseName) {
  process.stderr.write("Missing harness case name\n");
  process.exit(2);
}

try {
  const { stdout, stderr, result } = await captureIO(() => runCase(caseName));
  const payload: HarnessOk<unknown> = {
    ok: true,
    case: caseName,
    stdout,
    stderr,
    data: result,
  };
  process.stdout.write(JSON.stringify(payload));
} catch (err) {
  const payload: HarnessErr = {
    ok: false,
    case: caseName,
    stdout: "",
    stderr: "",
    error: errorToJson(err),
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(1);
}
