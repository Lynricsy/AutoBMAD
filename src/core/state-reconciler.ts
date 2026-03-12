import { Logger } from "./logger.js";
import { SprintStatusManager } from "./state-manager.js";
import {
  StoryStatus,
  WorkflowType,
  type IRunStateStore,
} from "./types.js";

export interface ReconciliationResult {
  downgradedStories: string[];
  staleCurrentStory: boolean;
  inconsistencies: Array<{ story: string; yamlStatus: string; reason: string }>;
}

type ReconcilerStateRepo = Pick<SprintStatusManager, "getAllStories" | "updateStatus">;

const GRANDFATHER_WORKFLOWS: WorkflowType[] = [
  WorkflowType.CreateStory,
  WorkflowType.DevStory,
  WorkflowType.CodeReview,
];

export async function reconcileStateOnResume(
  runStateStore: IRunStateStore,
  stateRepo: ReconcilerStateRepo,
  logger: Logger,
): Promise<ReconciliationResult> {
  const runState = await runStateStore.load();
  const storyStatuses = await stateRepo.getAllStories();

  const result: ReconciliationResult = {
    downgradedStories: [],
    staleCurrentStory: false,
    inconsistencies: [],
  };

  let grandfatheredStories = 0;

  for (const [storyKey, yamlStatus] of storyStatuses) {
    if (yamlStatus !== StoryStatus.Done) {
      continue;
    }

    const inCompletedStories = runState.completedStories.includes(storyKey);
    const completedWorkflows = runStateStore.getCompletedWorkflows(storyKey);
    const hasCompletedWorkflows = completedWorkflows.length > 0;
    const hasCodeReview = runStateStore.hasCompletedWorkflow(storyKey, WorkflowType.CodeReview);

    if (inCompletedStories && !hasCompletedWorkflows) {
      for (const workflow of GRANDFATHER_WORKFLOWS) {
        runStateStore.recordWorkflow(storyKey, workflow);
      }

      grandfatheredStories += 1;
      result.inconsistencies.push({
        story: storyKey,
        yamlStatus,
        reason: "legacy-completed-story-missing-workflow-history",
      });

      logger.info("Grandfathered legacy completed story workflow history", {
        event: "legacy-story-grandfathered",
        storyKey,
        workflows: GRANDFATHER_WORKFLOWS,
      });
      continue;
    }

    if (!inCompletedStories && !hasCodeReview) {
      await stateRepo.updateStatus(storyKey, StoryStatus.Review);

      result.downgradedStories.push(storyKey);
      result.inconsistencies.push({
        story: storyKey,
        yamlStatus,
        reason: "done-in-yaml-without-code-review-workflow",
      });

      logger.warn("Downgraded done story missing code-review workflow", {
        event: "story-downgraded",
        storyKey,
        from: yamlStatus,
        to: StoryStatus.Review,
      });
      continue;
    }

    if (inCompletedStories && !hasCodeReview) {
      result.inconsistencies.push({
        story: storyKey,
        yamlStatus,
        reason: "completed-story-missing-code-review-workflow",
      });

      logger.warn("Completed story is missing code-review workflow history", {
        event: "completed-story-missing-code-review",
        storyKey,
        completedWorkflows,
      });
    }
  }

  if (runState.currentStory && !storyStatuses.has(runState.currentStory)) {
    result.staleCurrentStory = true;
    logger.warn("Detected stale currentStory missing from sprint status", {
      event: "stale-current-story",
      storyKey: runState.currentStory,
    });
  }

  logger.info("Completed resume state reconciliation", {
    event: "state-reconciled",
    downgradedCount: result.downgradedStories.length,
    grandfatheredCount: grandfatheredStories,
    inconsistenciesCount: result.inconsistencies.length,
    staleCurrentStory: result.staleCurrentStory,
  });

  return result;
}
