import {
  ProjectCompleteReason,
  type IRunStateStore,
  type IStateRepository,
  type MultiSprintConfig,
  type MultiSprintResult,
  type SprintResult,
} from "./types.js";
import { detectDuplicateStories } from "./duplicate-detector.js";
import { DuplicateStoriesError, ProjectCompleteError } from "./errors.js";

type SprintOrchestratorLike = {
  runSprint(): Promise<SprintResult>;
};

type SprintArchiverLike = {
  archive(sprintNumber: number): Promise<void>;
};

export class MultiSprintOrchestrator {
  constructor(
    private orchestrator: SprintOrchestratorLike,
    private runState: IRunStateStore,
    private archiver: SprintArchiverLike,
    private stateRepo: IStateRepository,
    private config: MultiSprintConfig,
  ) {}

  async runAllSprints(): Promise<MultiSprintResult> {
    const startedAt = Date.now();

    const state = await this.runState.load();
    let currentSprint = state.currentSprint ?? 1;

    const sprintResults: SprintResult[] = [];
    let previousStoryKeys: string[] = [];
    let reason: ProjectCompleteReason = ProjectCompleteReason.MaxSprintsReached;

    while (currentSprint <= this.config.maxSprints) {
      console.log(`\n=== Sprint ${currentSprint} ===\n`);

      const stateToPersist = await this.runState.load();
      stateToPersist.currentSprint = currentSprint;
      this.runState.setCurrentSprint(currentSprint);
      await this.runState.save(stateToPersist);

      let result: SprintResult;
      try {
        result = await this.orchestrator.runSprint();
      } catch (error) {
        if (error instanceof ProjectCompleteError) {
          reason = ProjectCompleteReason.NoNewStories;
          break;
        }
        throw error;
      }

      sprintResults.push(result);

      if (result.status === "complete") {
        const currentKeys = Array.from((await this.stateRepo.getAllStories()).keys());

        if (previousStoryKeys.length > 0) {
          const dupResult = detectDuplicateStories(previousStoryKeys, currentKeys);
          if (dupResult.isDuplicate) {
            throw new DuplicateStoriesError(currentSprint, dupResult.duplicateKeys);
          }
        }

        await this.archiver.archive(currentSprint);
        previousStoryKeys = currentKeys;
        await this.runState.reset();
        currentSprint += 1;
        continue;
      }

      if (result.status === "failed") {
        console.log(`Sprint ${currentSprint} failed, skipping to next`);
        currentSprint += 1;
        continue;
      }

      if (result.status === "paused") {
        break;
      }
    }

    return {
      reason,
      totalSprints: sprintResults.length,
      sprintResults,
      durationMs: Date.now() - startedAt,
    };
  }
}

export type { SprintOrchestratorLike, SprintArchiverLike };
