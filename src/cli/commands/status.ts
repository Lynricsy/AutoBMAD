import { join } from "node:path";
import { Logger, LogLevel } from "../../core/logger.js";
import { SprintStatusManager } from "../../core/state-manager.js";
import { RunStateStore } from "../../core/run-state.js";
import { SprintOrchestrator } from "../../core/sprint-orchestrator.js";
import { StoryStatus, type AutoBMADConfig, type IWorkflowRunner } from "../../core/types.js";

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

function makeNoopRunner(): IWorkflowRunner {
  return {
    async run() {
      return {
        sessionId: "",
        success: false,
        durationMs: 0,
        messageCount: 0,
        summary: "Status command does not run workflows",
      };
    },
  };
}

export async function statusCommand(): Promise<void> {
  const argv = process.argv;
  const projectDir = parseDir(argv);
  const verbose = hasFlag(argv, "--verbose", "-v");

  const config: AutoBMADConfig = {
    projectDir,
    maxRetries: 3,
    timeout: 600_000,
    verbose,
  };

  const logger = new Logger("cli", {
    level: verbose ? LogLevel.Debug : LogLevel.Info,
    logDir: join(projectDir, ".autobmad-logs"),
  });

  const statusPath = join(
    projectDir,
    "_bmad-output/implementation-artifacts/sprint-status.yaml",
  );
  const stateRepo = new SprintStatusManager(statusPath);

  const runStatePath = join(projectDir, ".autobmad-state.json");
  const runState = new RunStateStore(runStatePath);

  const orchestrator = new SprintOrchestrator(stateRepo, makeNoopRunner(), runState, logger, config);
  const report = await orchestrator.getSprintStatus();

  const orderedStatuses: StoryStatus[] = [
    StoryStatus.Backlog,
    StoryStatus.ReadyForDev,
    StoryStatus.InProgress,
    StoryStatus.Review,
    StoryStatus.Done,
    StoryStatus.NeedsHumanIntervention,
  ];

  logger.table(
    ["status", "count"],
    orderedStatuses.map((st) => [st, String(report.byStatus[st] ?? 0)]),
  );

  const hasRunState = await Bun.file(runStatePath).exists();
  if (hasRunState) {
    const state = await runState.load();
    logger.table(
      ["runState", "value"],
      [
        ["currentStory", state.currentStory ?? "<none>"],
        ["completedStories", String(state.completedStories.length)],
        ["errors", String(state.errors.length)],
        ["lastUpdatedAt", state.lastUpdatedAt.toISOString()],
      ],
    );
  }

  process.exitCode = 0;
}
