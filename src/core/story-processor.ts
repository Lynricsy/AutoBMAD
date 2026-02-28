import {
  StoryStatus,
  WorkflowType,
  type AutoBMADConfig,
  type IRunStateStore,
  type IStateRepository,
  type IWorkflowRunner,
  type RunResult,
  type StoryResult,
} from "./types.js";
import { getLifecycle, getWorkflowAgent } from "./router.js";
import { renderPrompt, type WorkflowName } from "./prompts.js";
import {
  MaxRetriesExceededError,
  StoryCompleteError,
  WorkflowHaltError,
} from "./errors.js";
import { type Logger } from "./logger.js";

const STORY_STATUS_SET = new Set<string>(Object.values(StoryStatus));

function parseStoryStatus(raw: string, storyKey: string): StoryStatus {
  if (!STORY_STATUS_SET.has(raw)) {
    throw new Error(`Invalid story status for ${storyKey}: ${raw}`);
  }
  return raw as StoryStatus;
}

function normalizeCustomPrompts(
  prompts: AutoBMADConfig["prompts"],
): Partial<Record<WorkflowName, string>> | undefined {
  if (!prompts) return undefined;

  const normalized: Partial<Record<WorkflowName, string>> = {};

  for (const [key, value] of Object.entries(prompts)) {
    if (typeof value !== "string") continue;

    switch (key) {
      case WorkflowType.SprintPlanning:
        normalized["sprint-planning"] = value;
        break;
      case WorkflowType.CreateStory:
        normalized["create-story"] = value;
        break;
      case WorkflowType.DevStory:
        normalized["dev-story"] = value;
        break;
      case WorkflowType.CodeReview:
        normalized["code-review"] = value;
        break;
      default:
        break;
    }
  }

  return normalized;
}

function workflowTypeToName(workflow: WorkflowType): WorkflowName {
  switch (workflow) {
    case WorkflowType.SprintPlanning:
      return "sprint-planning";
    case WorkflowType.CreateStory:
      return "create-story";
    case WorkflowType.DevStory:
      return "dev-story";
    case WorkflowType.CodeReview:
      return "code-review";
    default: {
      const _exhaustive: never = workflow;
      throw new Error(`Unknown workflow type: ${_exhaustive}`);
    }
  }
}

export class StoryProcessor {
  constructor(
    private stateRepo: IStateRepository,
    private runner: IWorkflowRunner,
    private runState: IRunStateStore,
    private logger: Logger,
    private config: AutoBMADConfig,
  ) {}

  async processStory(storyKey: string): Promise<StoryResult> {
    const startedAt = Date.now();

    await this.runState.load();

    const customPrompts = normalizeCustomPrompts(this.config.prompts);
    let status = await this.readStoryStatus(storyKey);

    try {
      const lifecycle = getLifecycle(status);

      for (const step of lifecycle) {
        await this.runWorkflow(storyKey, step.workflow, customPrompts);
        status = await this.readStoryStatus(storyKey);

        if (step.workflow === WorkflowType.CodeReview) {
          status = await this.runFixLoopIfNeeded(storyKey, status, customPrompts);
        }
      }
    } catch (err) {
      if (err instanceof StoryCompleteError) {
        const durationMs = Date.now() - startedAt;
        this.runState.markComplete(storyKey);
        return { storyKey, success: true, retries: 0, durationMs };
      }
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    const retries = this.runState.getRetryCount(storyKey);
    this.runState.markComplete(storyKey);

    return { storyKey, success: true, retries, durationMs };
  }

  private async readStoryStatus(storyKey: string): Promise<StoryStatus> {
    const sprint = await this.stateRepo.readStatus();
    const raw = sprint.development_status[storyKey];

    if (typeof raw !== "string") {
      throw new Error(`Story ${storyKey} not found in sprint status`);
    }

    return parseStoryStatus(raw, storyKey);
  }

  private async runWorkflow(
    storyKey: string,
    workflow: WorkflowType,
    customPrompts?: Partial<Record<WorkflowName, string>>,
  ): Promise<RunResult> {
    const workflowName = workflowTypeToName(workflow);
    const prompt = renderPrompt(
      workflowName,
      { projectDir: this.config.projectDir, storyKey },
      customPrompts,
    );

    const agent = getWorkflowAgent(workflow);

    this.logger.info("Running workflow", { storyKey, workflow, agent });

    const result = await this.runner.run({
      message: prompt,
      agent,
      directory: this.config.projectDir,
      timeout: this.config.timeout,
    });

    if (!result.success) {
      this.logger.error("Workflow halted", {
        storyKey,
        workflow,
        agent,
        summary: result.summary,
      });

      this.runState.setError({
        message: result.summary,
        code: "E_WORKFLOW_HALT",
        timestamp: new Date(),
        storyKey,
        workflow,
      });

      throw new WorkflowHaltError(storyKey, workflow, result.summary);
    }

    return result;
  }

  private async runFixLoopIfNeeded(
    storyKey: string,
    statusAfterReview: StoryStatus,
    customPrompts?: Partial<Record<WorkflowName, string>>,
  ): Promise<StoryStatus> {
    let status = statusAfterReview;

    while (status !== StoryStatus.Done) {
      const retries = this.runState.getRetryCount(storyKey);

      if (retries >= this.config.maxRetries) {
        await this.stateRepo.updateStatus(storyKey, StoryStatus.NeedsHumanIntervention);

        this.logger.error("Max retries exceeded; marking needs-human-intervention", {
          storyKey,
          retries,
          maxRetries: this.config.maxRetries,
        });

        this.runState.setError({
          message: "Max retries exceeded",
          code: "E_MAX_RETRIES",
          timestamp: new Date(),
          storyKey,
          workflow: WorkflowType.CodeReview,
        });

        throw new MaxRetriesExceededError(storyKey, this.config.maxRetries);
      }

      this.logger.warn("Code review did not complete story; retrying dev+review", {
        storyKey,
        retries: retries + 1,
      });

      this.runState.incrementRetry(storyKey);

      await this.runWorkflow(storyKey, WorkflowType.DevStory, customPrompts);
      status = await this.readStoryStatus(storyKey);

      await this.runWorkflow(storyKey, WorkflowType.CodeReview, customPrompts);
      status = await this.readStoryStatus(storyKey);
    }

    return status;
  }
}
