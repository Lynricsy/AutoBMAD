import { test, expect, describe } from "bun:test";
import {
  StoryCompleteError,
  MaxRetriesExceededError,
  WorkflowHaltError,
  StateCorruptionError,
  ProjectCompleteError,
  MaxSprintsExceededError,
  DuplicateStoriesError,
} from "../../src/core/errors";
import { WorkflowType } from "../../src/core/types";

describe("StoryCompleteError", () => {
  test("extends Error", () => {
    const err = new StoryCompleteError("auth-login");
    expect(err instanceof Error).toBe(true);
  });

  test("has correct name", () => {
    const err = new StoryCompleteError("auth-login");
    expect(err.name).toBe("StoryCompleteError");
  });

  test("has correct message", () => {
    const err = new StoryCompleteError("auth-login");
    expect(err.message).toBe("Story auth-login is already complete");
  });

  test("stores storyKey", () => {
    const err = new StoryCompleteError("auth-login");
    expect(err.storyKey).toBe("auth-login");
  });

  test("can be caught with instanceof", () => {
    let caught: unknown;
    try {
      throw new StoryCompleteError("auth-login");
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof StoryCompleteError).toBe(true);
  });
});

describe("MaxRetriesExceededError", () => {
  test("extends Error", () => {
    const err = new MaxRetriesExceededError("auth-login", 3);
    expect(err instanceof Error).toBe(true);
  });

  test("has correct name", () => {
    const err = new MaxRetriesExceededError("auth-login", 3);
    expect(err.name).toBe("MaxRetriesExceededError");
  });

  test("has correct message", () => {
    const err = new MaxRetriesExceededError("auth-login", 3);
    expect(err.message).toBe("Story auth-login exceeded max retries (3)");
  });

  test("stores storyKey and maxRetries", () => {
    const err = new MaxRetriesExceededError("auth-login", 3);
    expect(err.storyKey).toBe("auth-login");
    expect(err.maxRetries).toBe(3);
  });

  test("can be caught with instanceof", () => {
    let caught: unknown;
    try {
      throw new MaxRetriesExceededError("auth-login", 3);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof MaxRetriesExceededError).toBe(true);
  });
});

describe("WorkflowHaltError", () => {
  test("extends Error", () => {
    const err = new WorkflowHaltError("auth-login", WorkflowType.DevStory, "timeout");
    expect(err instanceof Error).toBe(true);
  });

  test("has correct name", () => {
    const err = new WorkflowHaltError("auth-login", WorkflowType.DevStory, "timeout");
    expect(err.name).toBe("WorkflowHaltError");
  });

  test("has correct message", () => {
    const err = new WorkflowHaltError("auth-login", WorkflowType.DevStory, "timeout");
    expect(err.message).toBe(
      "Workflow dev-story halted for story auth-login: timeout"
    );
  });

  test("stores storyKey, workflow, and reason", () => {
    const err = new WorkflowHaltError("auth-login", WorkflowType.DevStory, "timeout");
    expect(err.storyKey).toBe("auth-login");
    expect(err.workflow).toBe(WorkflowType.DevStory);
    expect(err.reason).toBe("timeout");
  });

  test("can be caught with instanceof", () => {
    let caught: unknown;
    try {
      throw new WorkflowHaltError("auth-login", WorkflowType.DevStory, "timeout");
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof WorkflowHaltError).toBe(true);
  });
});

describe("StateCorruptionError", () => {
  test("extends Error", () => {
    const err = new StateCorruptionError("/path/to/file", "missing field");
    expect(err instanceof Error).toBe(true);
  });

  test("has correct name", () => {
    const err = new StateCorruptionError("/path/to/file", "missing field");
    expect(err.name).toBe("StateCorruptionError");
  });

  test("has correct message", () => {
    const err = new StateCorruptionError("/path/to/file", "missing field");
    expect(err.message).toBe(
      "State corruption detected in /path/to/file: missing field"
    );
  });

  test("stores filePath and details", () => {
    const err = new StateCorruptionError("/path/to/file", "missing field");
    expect(err.filePath).toBe("/path/to/file");
    expect(err.details).toBe("missing field");
  });

  test("can be caught with instanceof", () => {
    let caught: unknown;
    try {
      throw new StateCorruptionError("/path/to/file", "missing field");
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof StateCorruptionError).toBe(true);
  });
});

describe("ProjectCompleteError", () => {
  test("extends Error", () => {
    const err = new ProjectCompleteError("no-new-stories");
    expect(err instanceof Error).toBe(true);
  });

  test("has correct name", () => {
    const err = new ProjectCompleteError("no-new-stories");
    expect(err.name).toBe("ProjectCompleteError");
  });

  test("has correct message", () => {
    const err = new ProjectCompleteError("no-new-stories");
    expect(err.message).toBe("Project complete: no-new-stories");
  });

  test("stores reason", () => {
    const err = new ProjectCompleteError("no-new-stories");
    expect(err.reason).toBe("no-new-stories");
  });

  test("can be caught with instanceof", () => {
    let caught: unknown;
    try {
      throw new ProjectCompleteError("no-new-stories");
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof ProjectCompleteError).toBe(true);
  });
});

describe("MaxSprintsExceededError", () => {
  test("extends Error", () => {
    const err = new MaxSprintsExceededError(10);
    expect(err instanceof Error).toBe(true);
  });

  test("has correct name", () => {
    const err = new MaxSprintsExceededError(10);
    expect(err.name).toBe("MaxSprintsExceededError");
  });

  test("has correct message", () => {
    const err = new MaxSprintsExceededError(10);
    expect(err.message).toBe("Maximum sprints exceeded (10)");
  });

  test("stores maxSprints", () => {
    const err = new MaxSprintsExceededError(10);
    expect(err.maxSprints).toBe(10);
  });

  test("can be caught with instanceof", () => {
    let caught: unknown;
    try {
      throw new MaxSprintsExceededError(10);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof MaxSprintsExceededError).toBe(true);
  });
});

describe("DuplicateStoriesError", () => {
  test("extends Error", () => {
    const err = new DuplicateStoriesError(3, ["auth-login", "auth-signup"]);
    expect(err instanceof Error).toBe(true);
  });

  test("has correct name", () => {
    const err = new DuplicateStoriesError(3, ["auth-login", "auth-signup"]);
    expect(err.name).toBe("DuplicateStoriesError");
  });

  test("message contains sprint number", () => {
    const err = new DuplicateStoriesError(3, ["auth-login", "auth-signup"]);
    expect(err.message).toContain("Sprint 3");
  });

  test("message contains duplicate keys", () => {
    const err = new DuplicateStoriesError(3, ["auth-login", "auth-signup"]);
    expect(err.message).toContain("auth-login");
    expect(err.message).toContain("auth-signup");
  });

  test("stores sprintNumber and duplicateKeys", () => {
    const err = new DuplicateStoriesError(3, ["auth-login", "auth-signup"]);
    expect(err.sprintNumber).toBe(3);
    expect(err.duplicateKeys).toEqual(["auth-login", "auth-signup"]);
  });

  test("can be caught with instanceof", () => {
    let caught: unknown;
    try {
      throw new DuplicateStoriesError(3, ["auth-login", "auth-signup"]);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof DuplicateStoriesError).toBe(true);
  });
});
