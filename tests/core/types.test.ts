import { test, expect, describe } from "bun:test";
import {
  StoryStatus,
  EpicStatus,
  WorkflowType,
  AgentType,
} from "../../src/core/types.js";
import {
  StoryCompleteError,
  MaxRetriesExceededError,
  WorkflowHaltError,
  StateCorruptionError,
} from "../../src/core/errors.js";

describe("StoryStatus enum", () => {
  test("has correct string values", () => {
    expect(StoryStatus.Backlog).toBe("backlog");
    expect(StoryStatus.ReadyForDev).toBe("ready-for-dev");
    expect(StoryStatus.InProgress).toBe("in-progress");
    expect(StoryStatus.Review).toBe("review");
    expect(StoryStatus.Done).toBe("done");
    expect(StoryStatus.NeedsHumanIntervention).toBe("needs-human-intervention");
  });
});

describe("EpicStatus enum", () => {
  test("has correct string values", () => {
    expect(EpicStatus.Backlog).toBe("backlog");
    expect(EpicStatus.InProgress).toBe("in-progress");
    expect(EpicStatus.Done).toBe("done");
  });
});

describe("WorkflowType enum", () => {
  test("has correct string values", () => {
    expect(WorkflowType.SprintPlanning).toBe("sprint-planning");
    expect(WorkflowType.CreateStory).toBe("create-story");
    expect(WorkflowType.DevStory).toBe("dev-story");
    expect(WorkflowType.CodeReview).toBe("code-review");
  });
});

describe("AgentType enum", () => {
  test("has correct string values", () => {
    expect(AgentType.Sisyphus).toBe("sisyphus");
    expect(AgentType.Hephaestus).toBe("hephaestus");
  });
});

describe("StoryCompleteError", () => {
  test("instantiates with correct message", () => {
    const err = new StoryCompleteError("STORY-42");
    expect(err.message).toBe("Story STORY-42 is already complete");
  });

  test("has correct name property", () => {
    const err = new StoryCompleteError("STORY-1");
    expect(err.name).toBe("StoryCompleteError");
  });

  test("exposes storyKey field", () => {
    const err = new StoryCompleteError("STORY-99");
    expect(err.storyKey).toBe("STORY-99");
  });

  test("is instanceof Error", () => {
    const err = new StoryCompleteError("STORY-1");
    expect(err instanceof Error).toBe(true);
  });

  test("is instanceof StoryCompleteError", () => {
    const err = new StoryCompleteError("STORY-1");
    expect(err instanceof StoryCompleteError).toBe(true);
  });
});

describe("MaxRetriesExceededError", () => {
  test("instantiates with correct message", () => {
    const err = new MaxRetriesExceededError("STORY-7", 3);
    expect(err.message).toBe("Story STORY-7 exceeded max retries (3)");
  });

  test("has correct name property", () => {
    const err = new MaxRetriesExceededError("STORY-7", 3);
    expect(err.name).toBe("MaxRetriesExceededError");
  });

  test("exposes storyKey and maxRetries fields", () => {
    const err = new MaxRetriesExceededError("STORY-7", 5);
    expect(err.storyKey).toBe("STORY-7");
    expect(err.maxRetries).toBe(5);
  });

  test("is instanceof Error", () => {
    const err = new MaxRetriesExceededError("STORY-7", 3);
    expect(err instanceof Error).toBe(true);
  });

  test("is instanceof MaxRetriesExceededError", () => {
    const err = new MaxRetriesExceededError("STORY-7", 3);
    expect(err instanceof MaxRetriesExceededError).toBe(true);
  });
});

describe("WorkflowHaltError", () => {
  test("instantiates with correct message", () => {
    const err = new WorkflowHaltError("STORY-3", WorkflowType.DevStory, "agent timeout");
    expect(err.message).toBe("Workflow dev-story halted for story STORY-3: agent timeout");
  });

  test("has correct name property", () => {
    const err = new WorkflowHaltError("STORY-3", WorkflowType.DevStory, "reason");
    expect(err.name).toBe("WorkflowHaltError");
  });

  test("exposes storyKey, workflow, and reason fields", () => {
    const err = new WorkflowHaltError("STORY-3", WorkflowType.CodeReview, "bad output");
    expect(err.storyKey).toBe("STORY-3");
    expect(err.workflow).toBe(WorkflowType.CodeReview);
    expect(err.reason).toBe("bad output");
  });

  test("is instanceof Error", () => {
    const err = new WorkflowHaltError("STORY-3", WorkflowType.DevStory, "reason");
    expect(err instanceof Error).toBe(true);
  });

  test("is instanceof WorkflowHaltError", () => {
    const err = new WorkflowHaltError("STORY-3", WorkflowType.DevStory, "reason");
    expect(err instanceof WorkflowHaltError).toBe(true);
  });
});

describe("StateCorruptionError", () => {
  test("instantiates with correct message", () => {
    const err = new StateCorruptionError("/path/to/state.yaml", "invalid YAML");
    expect(err.message).toBe("State corruption detected in /path/to/state.yaml: invalid YAML");
  });

  test("has correct name property", () => {
    const err = new StateCorruptionError("/state.yaml", "missing field");
    expect(err.name).toBe("StateCorruptionError");
  });

  test("exposes filePath and details fields", () => {
    const err = new StateCorruptionError("/path/state.yaml", "null root");
    expect(err.filePath).toBe("/path/state.yaml");
    expect(err.details).toBe("null root");
  });

  test("is instanceof Error", () => {
    const err = new StateCorruptionError("/state.yaml", "bad");
    expect(err instanceof Error).toBe(true);
  });

  test("is instanceof StateCorruptionError", () => {
    const err = new StateCorruptionError("/state.yaml", "bad");
    expect(err instanceof StateCorruptionError).toBe(true);
  });
});
