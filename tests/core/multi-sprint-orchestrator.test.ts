import { describe, test, expect, mock, spyOn } from "bun:test";

import { MultiSprintOrchestrator } from "../../src/core/multi-sprint-orchestrator.js";
import {
  ProjectCompleteReason,
  StoryStatus,
  type IRunStateStore,
  type IStateRepository,
  type RunState,
  type SprintResult,
} from "../../src/core/types.js";
import { DuplicateStoriesError, ProjectCompleteError } from "../../src/core/errors.js";

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const now = new Date();
  return {
    currentStory: null,
    retries: {},
    errors: [],
    startedAt: now,
    lastUpdatedAt: now,
    completedStories: [],
    currentSprint: 1,
    ...overrides,
  };
}

function makeRunStateStore(initial: RunState) {
  let state = structuredClone(initial);

  const load = mock(async () => structuredClone(state));
  const save = mock(async (next: RunState) => {
    state = structuredClone(next);
  });

  const setCurrentSprint = mock((sprint: number) => {
    state.currentSprint = sprint;
  });
  const reset = mock(async () => {
    state = makeRunState({ currentSprint: 1 });
  });

  const store: IRunStateStore = {
    load,
    save,
    getRetryCount: () => 0,
    incrementRetry: () => {},
    setError: () => {},
    clearStory: () => {},
    markComplete: () => {},
    setCurrentSprint,
    reset,
  };

  return {
    store,
    getState: () => state,
    load,
    save,
    setCurrentSprint,
    reset,
  };
}

function makeStateRepo(storyKeysPerCall: string[][]) {
  let call = 0;
  const getAllStories = mock(async () => {
    const keys = storyKeysPerCall[Math.min(call, storyKeysPerCall.length - 1)] ?? [];
    call += 1;
    return new Map(keys.map((k) => [k, StoryStatus.Done] as const));
  });

  const repo: IStateRepository = {
    async readStatus() {
      throw new Error("not used");
    },
    async updateStatus() {
      throw new Error("not used");
    },
    async getNextStory() {
      throw new Error("not used");
    },
    getAllStories,
    async isSprintComplete() {
      throw new Error("not used");
    },
  };

  return { repo, getAllStories };
}

function makeArchiver() {
  const archive = mock(async (_sprint: number) => {});
  return { archive };
}

function makeOrchestrator(sequence: Array<SprintResult | Error>) {
  let call = 0;
  const runSprint = mock(async () => {
    const next = sequence[call];
    call += 1;
    if (!next) {
      throw new Error("orchestrator sequence exhausted");
    }
    if (next instanceof Error) throw next;
    return next;
  });

  return { runSprint };
}

function completeResult(overrides: Partial<SprintResult> = {}): SprintResult {
  return {
    status: "complete",
    totalStories: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    results: [],
    durationMs: 10,
    ...overrides,
  };
}

function failedResult(overrides: Partial<SprintResult> = {}): SprintResult {
  return {
    status: "failed",
    totalStories: 1,
    completed: 0,
    failed: 1,
    skipped: 0,
    results: [],
    durationMs: 10,
    ...overrides,
  };
}

function pausedResult(overrides: Partial<SprintResult> = {}): SprintResult {
  return {
    status: "paused",
    totalStories: 1,
    completed: 0,
    failed: 1,
    skipped: 0,
    results: [],
    durationMs: 10,
    ...overrides,
  };
}

describe("MultiSprintOrchestrator", () => {
  test("runs 2 sprints then stops on ProjectCompleteError (no new stories)", async () => {
    const orchestrator = makeOrchestrator([
      completeResult(),
      completeResult(),
      new ProjectCompleteError("no-new-stories"),
    ]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-story-a"], ["2-1-story-b"]]);
    const config = { maxSprints: 10 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    const result = await multi.runAllSprints();

    expect(result.reason).toBe(ProjectCompleteReason.NoNewStories);
    expect(result.totalSprints).toBe(2);
    expect(result.sprintResults).toHaveLength(2);
    expect(archiver.archive.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  test("maxSprints=2 limits execution to 2 sprints", async () => {
    const orchestrator = makeOrchestrator([completeResult(), completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"], ["2-1-b"], ["3-1-c"]]);
    const config = { maxSprints: 2 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    const result = await multi.runAllSprints();

    expect(orchestrator.runSprint.mock.calls).toHaveLength(2);
    expect(result.reason).toBe(ProjectCompleteReason.MaxSprintsReached);
    expect(result.totalSprints).toBe(2);
    expect(result.sprintResults).toHaveLength(2);
  });

  test("duplicate stories detected -> throws DuplicateStoriesError", async () => {
    const orchestrator = makeOrchestrator([completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-same"], ["2-1-same"]]);
    const config = { maxSprints: 2 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    try {
      await multi.runAllSprints();
      throw new Error("expected DuplicateStoriesError");
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateStoriesError);
      const dup = err as DuplicateStoriesError;
      expect(dup.sprintNumber).toBe(2);
      expect(dup.duplicateKeys).toEqual(["2-1-same"]);
    }

    expect(archiver.archive.mock.calls.map((c) => c[0])).toEqual([1]);
  });

  test("archiver.archive() called with correct sprint numbers", async () => {
    const orchestrator = makeOrchestrator([completeResult(), completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"], ["2-1-b"], ["3-1-c"]]);
    const config = { maxSprints: 3 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    await multi.runAllSprints();

    expect(archiver.archive.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  test("setCurrentSprint called incrementally (1, 2, 3)", async () => {
    const orchestrator = makeOrchestrator([completeResult(), completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"], ["2-1-b"], ["3-1-c"]]);
    const config = { maxSprints: 3 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    await multi.runAllSprints();

    expect(runState.setCurrentSprint.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  test("reset() called after each completed sprint", async () => {
    const orchestrator = makeOrchestrator([completeResult(), completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"], ["2-1-b"], ["3-1-c"]]);
    const config = { maxSprints: 3 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    await multi.runAllSprints();

    expect(runState.reset.mock.calls).toHaveLength(3);
  });

  test("logs progress messages via console.log", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const orchestrator = makeOrchestrator([completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"], ["2-1-b"]]);
    const config = { maxSprints: 2 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    await multi.runAllSprints();

    const messages = logSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(messages.some((m) => m.includes("=== Sprint 1 ==="))).toBe(true);
    expect(messages.some((m) => m.includes("=== Sprint 2 ==="))).toBe(true);

    logSpy.mockRestore();
  });

  test("status='failed' -> skip and continue to next sprint", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const orchestrator = makeOrchestrator([failedResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["2-1-ok"]]);
    const config = { maxSprints: 2 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    const result = await multi.runAllSprints();

    expect(result.sprintResults.map((r) => r.status)).toEqual(["failed", "complete"]);
    expect(archiver.archive.mock.calls.map((c) => c[0])).toEqual([2]);
    expect(runState.reset.mock.calls).toHaveLength(1);
    expect(logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")).toContain(
      "Sprint 1 failed, skipping to next",
    );

    logSpy.mockRestore();
  });

  test("status='paused' -> stop loop and return partial result", async () => {
    const orchestrator = makeOrchestrator([completeResult(), pausedResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"]]);
    const config = { maxSprints: 5 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    const result = await multi.runAllSprints();

    expect(result.sprintResults.map((r) => r.status)).toEqual(["complete", "paused"]);
    expect(archiver.archive.mock.calls.map((c) => c[0])).toEqual([1]);
    expect(runState.reset.mock.calls).toHaveLength(1);
    expect(result.totalSprints).toBe(2);
  });

  test("returns MultiSprintResult with expected fields", async () => {
    const orchestrator = makeOrchestrator([completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"], ["2-1-b"]]);
    const config = { maxSprints: 2 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    const result = await multi.runAllSprints();

    expect(result.reason).toBe(ProjectCompleteReason.MaxSprintsReached);
    expect(result.totalSprints).toBe(2);
    expect(result.sprintResults).toHaveLength(2);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("resume from currentSprint=3", async () => {
    const orchestrator = makeOrchestrator([completeResult(), completeResult()]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 3 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["3-1-a"], ["4-1-b"]]);
    const config = { maxSprints: 4 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    const result = await multi.runAllSprints();

    expect(runState.setCurrentSprint.mock.calls.map((c) => c[0])).toEqual([3, 4]);
    expect(result.totalSprints).toBe(2);
    expect(result.reason).toBe(ProjectCompleteReason.MaxSprintsReached);
  });

  test("single sprint completes successfully then project complete", async () => {
    const orchestrator = makeOrchestrator([
      completeResult(),
      new ProjectCompleteError("no-new-stories"),
    ]);
    const runState = makeRunStateStore(makeRunState({ currentSprint: 1 }));
    const archiver = makeArchiver();
    const stateRepo = makeStateRepo([["1-1-a"]]);
    const config = { maxSprints: 10 };

    const multi = new MultiSprintOrchestrator(
      orchestrator,
      runState.store,
      archiver,
      stateRepo.repo,
      config,
    );

    const result = await multi.runAllSprints();

    expect(result.reason).toBe(ProjectCompleteReason.NoNewStories);
    expect(result.totalSprints).toBe(1);
    expect(result.sprintResults).toHaveLength(1);
  });
});
