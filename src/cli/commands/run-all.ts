import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { Logger, LogLevel } from "../../core/logger.js";
import { SprintStatusManager } from "../../core/state-manager.js";
import { RunStateStore } from "../../core/run-state.js";
import { WorkflowRunner } from "../../core/runner.js";
import { SprintOrchestrator } from "../../core/sprint-orchestrator.js";
import { SprintArchiver } from "../../core/sprint-archiver.js";
import { MultiSprintOrchestrator } from "../../core/multi-sprint-orchestrator.js";
import { ProjectCompleteReason } from "../../core/types.js";

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

export function mapMultiSprintExitCode(reason: ProjectCompleteReason): number {
  switch (reason) {
    case ProjectCompleteReason.NoNewStories:
      return 0;
    case ProjectCompleteReason.DuplicateStoriesDetected:
      return 1;
    case ProjectCompleteReason.MaxSprintsReached:
      return 2;
  }
}

function checkOpencodeDependency(): void {
  const found = Bun.which("opencode");
  if (!found) {
    process.stderr.write(
      `[autobmad] ⚠️  Warning: 'opencode' (oh-my-opencode) not found in PATH. AutoBMAD requires oh-my-opencode to run sprint workflows. Install: https://github.com/anthropics/opencode\n`,
    );
  }
}

export async function runAllCommand(): Promise<void> {
  checkOpencodeDependency();
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

  const artifactsDir = join(config.projectDir, "_bmad-output/implementation-artifacts");

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
  const archiver = new SprintArchiver(artifactsDir);

  const multiOrchestrator = new MultiSprintOrchestrator(
    orchestrator,
    runState,
    archiver,
    stateRepo,
    { maxSprints: config.maxSprints ?? 10 },
  );

  const result = await multiOrchestrator.runAllSprints();

  if (result.reason === ProjectCompleteReason.NoNewStories) {
    logger.info("All sprints complete — no new stories remain", {
      totalSprints: result.totalSprints,
      durationMs: result.durationMs,
    });
  } else if (result.reason === ProjectCompleteReason.MaxSprintsReached) {
    logger.warn("Max sprints reached", {
      totalSprints: result.totalSprints,
      durationMs: result.durationMs,
    });
  } else {
    logger.error("Duplicate stories detected — aborting multi-sprint run", {
      totalSprints: result.totalSprints,
      durationMs: result.durationMs,
    });
  }

  process.exitCode = mapMultiSprintExitCode(result.reason);
}
