import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { Logger, LogLevel } from "../../core/logger.js";
import { SprintStatusManager } from "../../core/state-manager.js";
import { RunStateStore } from "../../core/run-state.js";
import { WorkflowRunner } from "../../core/runner.js";
import { SprintOrchestrator } from "../../core/sprint-orchestrator.js";

function hasFlag(argv: string[], name: string, short?: string): boolean {
  return argv.includes(name) || (short ? argv.includes(short) : false);
}

function parseDir(argv: string[]): string {
  const idx = argv.findIndex((arg) => arg === "--dir" || arg === "-d");
  if (idx === -1) return process.cwd();
  const value = argv[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("Missing value for --dir");
  }
  return value;
}

function mapSprintExitCode(status: "complete" | "paused" | "failed"): number {
  switch (status) {
    case "complete":
      return 0;
    case "paused":
      return 2;
    case "failed":
      return 1;
  }
}

export async function startCommand(): Promise<void> {
  const argv = process.argv;
  parseDir(argv);
  hasFlag(argv, "--verbose", "-v");

  const config = await loadConfig(argv);

  const logger = new Logger("cli", {
    level: config.verbose ? LogLevel.Debug : LogLevel.Info,
    logDir: join(config.projectDir, ".autobmad-logs"),
  });

  const statusPath = join(
    config.projectDir,
    "_bmad-output/implementation-artifacts/sprint-status.yaml",
  );

  const stateRepo = new SprintStatusManager(statusPath);
  const runState = new RunStateStore(join(config.projectDir, ".autobmad-state.json"));

  const runner = new WorkflowRunner(
    { timeout: config.timeout },
    {
      spawn: (cmd, options) => Bun.spawn(cmd, options),
      signals: process,
      now: () => Date.now(),
      setTimeout,
      clearTimeout,
    },
  );

  const orchestrator = new SprintOrchestrator(stateRepo, runner, runState, logger, config);
  const result = await orchestrator.runSprint();

  if (result.status === "complete") {
    logger.info("Sprint complete", {
      totalStories: result.totalStories,
      completed: result.completed,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });
  } else if (result.status === "paused") {
    logger.warn("Sprint paused", {
      totalStories: result.totalStories,
      completed: result.completed,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });
  } else {
    logger.error("Sprint failed", {
      totalStories: result.totalStories,
      completed: result.completed,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });
  }

  process.exitCode = mapSprintExitCode(result.status);
}
