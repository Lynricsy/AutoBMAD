import {
  AgentType,
  StoryStatus,
  WorkflowType,
  type AutoBMADConfig,
  type ErrorInfo,
  type IRunStateStore,
  type IStateRepository,
  type IWorkflowRunner,
  type SprintResult,
  type StoryResult,
} from "./types.js";
import {
  MaxRetriesExceededError,
  StateCorruptionError,
  WorkflowHaltError,
} from "./errors.js";
import { StoryProcessor } from "./story-processor.js";
import { renderPrompt } from "./prompts.js";
import { type Logger } from "./logger.js";
import { reconcileStateOnResume } from "./state-reconciler.js";
import {
  renderError,
  renderSprintBanner,
  renderSprintSummary,
  renderStoryComplete,
} from "../cli/dashboard.js";

export interface SprintStatusReport {
  totalStories: number;
  byStatus: Record<StoryStatus, number>;
}

function formatUnknownError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

function makeErrorInfo(params: {
  message: string;
  code: string;
  timestamp?: Date;
  storyKey?: string;
  workflow?: WorkflowType;
  stack?: string;
}): ErrorInfo {
  return {
    message: params.message,
    code: params.code,
    timestamp: params.timestamp ?? new Date(),
    storyKey: params.storyKey,
    workflow: params.workflow,
    stack: params.stack,
  };
}

export class SprintOrchestrator {
  constructor(
    private stateRepo: IStateRepository,
    private runner: IWorkflowRunner,
    private runState: IRunStateStore,
    private logger: Logger,
    private config: AutoBMADConfig,
  ) {}

  async runSprint(): Promise<SprintResult> {
    const startTime = Date.now();
    const storyProcessor = new StoryProcessor(
      this.stateRepo,
      this.runner,
      this.runState,
      this.logger,
      this.config,
    );

    const results: StoryResult[] = [];
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let totalStories = 0;

    const sigintHandler = () => {
      void this.flushRunStateOnInterrupt();
    };

    process.on("SIGINT", sigintHandler);

    try {
      const initialRunState = await this.runState.load();
      const completedStories = new Set(initialRunState.completedStories);

      let forcedStory: string | null = initialRunState.currentStory;
      if (!forcedStory) {
        await this.ensureSprintPlanned();
      }

      const shouldReconcileResumeState =
        initialRunState.currentStory === null &&
        (initialRunState.completedStories.length > 0 ||
          Object.keys(initialRunState.completedWorkflows).length > 0 ||
          Object.keys(initialRunState.retries).length > 0);

      if (shouldReconcileResumeState) {
        const reconciliation = await reconcileStateOnResume(
          this.runState,
          this.stateRepo,
          this.logger,
        );

        this.logger.info("Resume reconciliation result", {
          event: "resume-reconciliation-result",
          downgradedStories: reconciliation.downgradedStories,
          staleCurrentStory: reconciliation.staleCurrentStory,
          inconsistencies: reconciliation.inconsistencies,
        });

        if (reconciliation.staleCurrentStory && forcedStory) {
          forcedStory = null;
          this.logger.warn("Ignoring stale currentStory during sprint resume", {
            event: "stale-current-story-ignored",
            storyKey: initialRunState.currentStory,
          });
        }
      }

      if (forcedStory) {
        this.logger.info("resuming sprint", { storyKey: forcedStory });
      }

      totalStories = (await this.stateRepo.getAllStories()).size;
      let storyIndex = completedStories.size;

      if (!this.logger.silent) {
        renderSprintBanner(this.config, totalStories);
      }

      while (!(await this.stateRepo.isSprintComplete())) {
        const storyKey = forcedStory ?? (await this.stateRepo.getNextStory());
        forcedStory = null;

        if (!storyKey) break;

        if (completedStories.has(storyKey)) {
          const hasCodeReview = this.runState.hasCompletedWorkflow(
            storyKey,
            WorkflowType.CodeReview,
          );

          if (hasCodeReview) {
            await this.stateRepo.updateStatus(storyKey, StoryStatus.Done);
            this.runState.clearStory();
            continue;
          }

          completedStories.delete(storyKey);
          storyIndex = Math.min(storyIndex, completedStories.size);

          this.logger.warn("story in completedStories but missing code-review workflow", {
            event: "blind-skip-prevented",
            storyKey,
          });
        }

        await this.saveCurrentStory(storyKey);

        try {
          storyIndex += 1;
          const result = await storyProcessor.processStory(
            storyKey,
            storyIndex,
            totalStories,
          );
          results.push(result);
          completed += 1;

          if (!this.logger.silent) {
            renderStoryComplete(storyKey, result);
          }
        } catch (err) {
          if (err instanceof MaxRetriesExceededError) {
            skipped += 1;

            this.logger.error("Max retries exceeded; skipping story", {
              storyKey,
              maxRetries: err.maxRetries,
            });

            this.runState.clearStory();

            const skippedResult: StoryResult = {
              storyKey,
              success: false,
              retries: err.maxRetries,
              error: makeErrorInfo({
                message: err.message,
                code: "E_MAX_RETRIES",
                storyKey,
                workflow: WorkflowType.CodeReview,
              }),
              durationMs: 0,
            };

            results.push(skippedResult);

            if (!this.logger.silent) {
              renderStoryComplete(storyKey, skippedResult);
            }

            continue;
          }

          const formatted = formatUnknownError(err);
          const retries = this.runState.getRetryCount(storyKey);
          failed += 1;

          this.logger.error("Sprint paused due to story error", {
            storyKey,
            error: formatted.message,
          });

          const pauseErrorInfo =
            err instanceof WorkflowHaltError
              ? makeErrorInfo({
                  message: err.reason,
                  code: "E_SPRINT_PAUSED",
                  storyKey,
                  workflow: err.workflow,
                  stack: formatted.stack,
                })
              : makeErrorInfo({
                  message: formatted.message,
                  code: "E_SPRINT_PAUSED",
                  storyKey,
                  stack: formatted.stack,
                });

          if (err instanceof WorkflowHaltError) {
            this.runState.setError(pauseErrorInfo);

            if (!this.logger.silent) {
              renderError(storyKey, err.workflow, err.reason || err.message);
            }
          } else {
            this.runState.setError(pauseErrorInfo);
          }

          results.push({
            storyKey,
            success: false,
            retries,
            error: pauseErrorInfo,
            durationMs: 0,
          });

          this.logger.info("To resume, run the sprint orchestrator again", {
            storyKey,
          });

          const result: SprintResult = {
            status: "paused",
            totalStories,
            completed,
            failed,
            skipped,
            results,
            durationMs: Date.now() - startTime,
          };

          if (!this.logger.silent) {
            renderSprintSummary(result, Date.now() - startTime);
          }

          return result;
        }
      }

      const isComplete = await this.stateRepo.isSprintComplete();
      const status: SprintResult["status"] = isComplete ? "complete" : "paused";

      const result: SprintResult = {
        status,
        totalStories,
        completed,
        failed,
        skipped,
        results,
        durationMs: Date.now() - startTime,
      };

      if (!this.logger.silent) {
        renderSprintSummary(result, Date.now() - startTime);
      }

      return result;
    } catch (err) {
      const formatted = formatUnknownError(err);
      this.logger.error("Sprint orchestrator failed", {
        error: formatted.message,
      });
      this.runState.setError(
        makeErrorInfo({
          message: formatted.message,
          code: "E_SPRINT_FAILED",
          stack: formatted.stack,
        }),
      );

      const result: SprintResult = {
        status: "failed",
        totalStories,
        completed,
        failed,
        skipped,
        results,
        durationMs: Date.now() - startTime,
      };

      if (!this.logger.silent) {
        renderSprintSummary(result, Date.now() - startTime);
      }

      return result;
    } finally {
      process.removeListener("SIGINT", sigintHandler);
    }
  }

  async resumeSprint(): Promise<SprintResult> {
    await this.runState.load();
    return await this.runSprint();
  }

  async getSprintStatus(): Promise<SprintStatusReport> {
    const stories = await this.stateRepo.getAllStories();
    const byStatus: Record<StoryStatus, number> = {
      [StoryStatus.Backlog]: 0,
      [StoryStatus.ReadyForDev]: 0,
      [StoryStatus.InProgress]: 0,
      [StoryStatus.Review]: 0,
      [StoryStatus.Done]: 0,
      [StoryStatus.NeedsHumanIntervention]: 0,
    };

    for (const status of stories.values()) {
      byStatus[status] += 1;
    }

    return {
      totalStories: stories.size,
      byStatus,
    };
  }

  private async flushRunStateOnInterrupt(): Promise<void> {
    try {
      const state = await this.runState.load();
      await this.runState.save(state);
    } catch (e) {
      this.logger.error("Failed to flush run state on interrupt", {
        event: "sigint-flush-failed",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      process.exit(1);
    }
  }

  private async saveCurrentStory(storyKey: string): Promise<void> {
    const state = await this.runState.load();
    state.currentStory = storyKey;
    await this.runState.save(state);
  }

  private async ensureSprintPlanned(): Promise<void> {
    let needsPlanning = false;

    try {
      const stories = await this.stateRepo.getAllStories();
      needsPlanning = stories.size === 0;
    } catch (err) {
      if (err instanceof StateCorruptionError) {
        needsPlanning = true;
      } else {
        throw err;
      }
    }

    if (!needsPlanning) return;

    this.logger.info("Running sprint planning", {});

    const custom = this.config.prompts?.[WorkflowType.SprintPlanning];
    const customPrompts =
      typeof custom === "string" ? { "sprint-planning": custom } : undefined;

    const state = await this.runState.load();
    const prompt = renderPrompt(
      "sprint-planning",
      {
        projectDir: this.config.projectDir,
        currentSprint: String(state.currentSprint ?? 1),
      },
      customPrompts,
    );

    const result = await this.runner.run({
      message: prompt,
      agent: AgentType.Sisyphus,
      directory: this.config.projectDir,
      timeout: this.config.timeout,
    });

    if (!result.success) {
      this.logger.error("Sprint planning halted", { summary: result.summary });
      throw new Error(`Sprint planning failed: ${result.summary}`);
    }
  }
}
