import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  reconcileStateOnResume,
} from "../../src/core/state-reconciler.js";
import { Logger, LogLevel } from "../../src/core/logger.js";
import { SprintStatusManager } from "../../src/core/state-manager.js";
import {
  StoryStatus,
  WorkflowType,
  type ErrorInfo,
  type IRunStateStore,
  type RunState,
} from "../../src/core/types.js";

class StubLogger extends Logger {
  readonly infos: Array<{ message: string; data?: Record<string, unknown> }> = [];
  readonly warns: Array<{ message: string; data?: Record<string, unknown> }> = [];

  constructor() {
    super("state-reconciler-test", {
      level: LogLevel.Debug,
      logDir: "/tmp/autobmad-state-reconciler-test-logs",
      silent: true,
    });
  }

  debug(_message: string, _data?: Record<string, unknown>): void {}

  info(message: string, data?: Record<string, unknown>): void {
    this.infos.push({ message, data });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.warns.push({ message, data });
  }

  error(_message: string, _data?: Record<string, unknown>): void {}
  fatal(_message: string, _data?: Record<string, unknown>): void {}
}

function writeSprintStatusFile(filePath: string, statuses: Record<string, StoryStatus>): void {
  const developmentStatus = Object.entries(statuses)
    .map(([storyKey, status]) => `  ${storyKey}: ${status}`)
    .join("\n");

  writeFileSync(
    filePath,
    [
      "generated: 2026-03-12",
      "project: Test",
      "project_key: T",
      "tracking_system: file-system",
      "story_location: '{project-root}'",
      "development_status:",
      developmentStatus,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function makeSprintStatusManager(statuses: Record<string, StoryStatus>) {
  const dir = mkdtempSync(join(tmpdir(), "autobmad-state-reconciler-"));
  const statusFilePath = join(dir, "sprint-status.yaml");
  writeSprintStatusFile(statusFilePath, statuses);

  return {
    dir,
    repo: new SprintStatusManager(statusFilePath),
  };
}

function makeRunStateStore(initial: Partial<RunState> = {}) {
  const now = new Date();
  let state: RunState = {
    currentStory: null,
    retries: {},
    errors: [],
    startedAt: now,
    lastUpdatedAt: now,
    completedStories: [],
    completedWorkflows: {},
    currentSprint: 1,
    ...initial,
  };

  const recordedWorkflows: Array<{ storyKey: string; workflow: WorkflowType }> = [];

  const store: IRunStateStore = {
    async load(): Promise<RunState> {
      return structuredClone(state);
    },

    async save(next: RunState): Promise<void> {
      state = structuredClone(next);
    },

    getRetryCount(storyKey: string): number {
      return state.retries[storyKey] ?? 0;
    },

    incrementRetry(storyKey: string): void {
      const current = state.retries[storyKey] ?? 0;
      state.retries[storyKey] = current + 1;
    },

    recordWorkflow(storyKey: string, workflow: WorkflowType): void {
      recordedWorkflows.push({ storyKey, workflow });
      const completed = state.completedWorkflows[storyKey] ?? [];
      if (!completed.includes(workflow)) {
        state.completedWorkflows[storyKey] = [...completed, workflow];
      }
    },

    getCompletedWorkflows(storyKey: string): WorkflowType[] {
      return [...(state.completedWorkflows[storyKey] ?? [])];
    },

    hasCompletedWorkflow(storyKey: string, workflow: WorkflowType): boolean {
      return (state.completedWorkflows[storyKey] ?? []).includes(workflow);
    },

    setError(error: ErrorInfo): void {
      state.errors.push(error);
    },

    clearStory(): void {
      state.currentStory = null;
    },

    markComplete(storyKey: string): void {
      if (!state.completedStories.includes(storyKey)) {
        state.completedStories.push(storyKey);
      }
      delete state.retries[storyKey];
      state.currentStory = null;
    },

    setCurrentSprint(sprint: number): void {
      state.currentSprint = sprint;
    },

    async reset(): Promise<void> {
      const nextNow = new Date();
      state = {
        currentStory: null,
        retries: {},
        errors: [],
        startedAt: nextNow,
        lastUpdatedAt: nextNow,
        completedStories: [],
        completedWorkflows: {},
        currentSprint: 1,
      };
    },
  };

  return {
    store,
    getState: () => structuredClone(state),
    recordedWorkflows,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reconcileStateOnResume", () => {
  const story1 = "0-1-story-1";
  const story2 = "0-2-story-2";
  const story3 = "0-3-story-3";

  test("Done story without code-review workflow is downgraded to review", async () => {
    const { dir, repo } = makeSprintStatusManager({
      [story1]: StoryStatus.Done,
    });
    tempDirs.push(dir);

    const { store } = makeRunStateStore();
    const logger = new StubLogger();

    const result = await reconcileStateOnResume(store, repo, logger);
    const stories = await repo.getAllStories();

    expect(result.downgradedStories).toEqual([story1]);
    expect(result.staleCurrentStory).toBe(false);
    expect(result.inconsistencies).toEqual([
      {
        story: story1,
        yamlStatus: StoryStatus.Done,
        reason: "done-in-yaml-without-code-review-workflow",
      },
    ]);
    expect(stories.get(story1)).toBe(StoryStatus.Review);
  });

  test("Done story with code-review workflow and completedStories is left untouched", async () => {
    const { dir, repo } = makeSprintStatusManager({
      [story1]: StoryStatus.Done,
    });
    tempDirs.push(dir);

    const { store } = makeRunStateStore({
      completedStories: [story1],
      completedWorkflows: {
        [story1]: [WorkflowType.CodeReview],
      },
    });

    const result = await reconcileStateOnResume(store, repo, new StubLogger());
    const stories = await repo.getAllStories();

    expect(result).toEqual({
      downgradedStories: [],
      staleCurrentStory: false,
      inconsistencies: [],
    });
    expect(stories.get(story1)).toBe(StoryStatus.Done);
  });

  test("Grandfather clause backfills legacy completed stories with missing workflow history", async () => {
    const { dir, repo } = makeSprintStatusManager({
      [story1]: StoryStatus.Done,
    });
    tempDirs.push(dir);

    const { store, getState, recordedWorkflows } = makeRunStateStore({
      completedStories: [story1],
      completedWorkflows: {},
    });

    const result = await reconcileStateOnResume(store, repo, new StubLogger());
    const workflows = getState().completedWorkflows[story1];

    expect(result.downgradedStories).toEqual([]);
    expect(workflows).toEqual([
      WorkflowType.CreateStory,
      WorkflowType.DevStory,
      WorkflowType.CodeReview,
    ]);
    expect(recordedWorkflows).toEqual([
      { storyKey: story1, workflow: WorkflowType.CreateStory },
      { storyKey: story1, workflow: WorkflowType.DevStory },
      { storyKey: story1, workflow: WorkflowType.CodeReview },
    ]);
  });

  test("Stale currentStory is detected when it no longer exists in YAML", async () => {
    const { dir, repo } = makeSprintStatusManager({
      [story1]: StoryStatus.Review,
    });
    tempDirs.push(dir);

    const { store } = makeRunStateStore({
      currentStory: "0-9-missing-story",
    });
    const logger = new StubLogger();

    const result = await reconcileStateOnResume(store, repo, logger);

    expect(result.staleCurrentStory).toBe(true);
    expect(logger.warns.some((entry) => entry.message.includes("stale currentStory"))).toBe(true);
  });

  test("Mixed state reconciliation handles downgrade, grandfathering, and consistent done stories", async () => {
    const { dir, repo } = makeSprintStatusManager({
      [story1]: StoryStatus.Done,
      [story2]: StoryStatus.Done,
      [story3]: StoryStatus.Done,
      "0-4-story-4": StoryStatus.Review,
    });
    tempDirs.push(dir);

    const { store, getState } = makeRunStateStore({
      currentStory: "0-9-missing-story",
      completedStories: [story2, story3],
      completedWorkflows: {
        [story3]: [WorkflowType.CodeReview],
      },
    });

    const result = await reconcileStateOnResume(store, repo, new StubLogger());
    const stories = await repo.getAllStories();

    expect(result.downgradedStories).toEqual([story1]);
    expect(result.staleCurrentStory).toBe(true);
    expect(result.inconsistencies).toEqual([
      {
        story: story1,
        yamlStatus: StoryStatus.Done,
        reason: "done-in-yaml-without-code-review-workflow",
      },
      {
        story: story2,
        yamlStatus: StoryStatus.Done,
        reason: "legacy-completed-story-missing-workflow-history",
      },
    ]);

    expect(stories.get(story1)).toBe(StoryStatus.Review);
    expect(stories.get(story2)).toBe(StoryStatus.Done);
    expect(stories.get(story3)).toBe(StoryStatus.Done);
    expect(getState().completedWorkflows[story2]).toEqual([
      WorkflowType.CreateStory,
      WorkflowType.DevStory,
      WorkflowType.CodeReview,
    ]);
  });
});
