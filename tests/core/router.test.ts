import { describe, test, expect } from "bun:test";
import { StoryStatus, WorkflowType, AgentType } from "../../src/core/types.js";
import { StoryCompleteError } from "../../src/core/errors.js";
import { getLifecycle, getWorkflowAgent, validateTransition } from "../../src/core/router.js";

describe("getLifecycle", () => {
  test("backlog returns 3 steps starting with CreateStory", () => {
    const steps = getLifecycle(StoryStatus.Backlog);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      workflow: WorkflowType.CreateStory,
      agent: AgentType.Sisyphus,
      description: "Create story file",
    });
    expect(steps[1]).toEqual({
      workflow: WorkflowType.DevStory,
      agent: AgentType.Sisyphus,
      description: "Develop story",
    });
    expect(steps[2]).toEqual({
      workflow: WorkflowType.CodeReview,
      agent: AgentType.Hephaestus,
      description: "Review code",
    });
  });

  test("ready-for-dev returns 2 steps starting with DevStory", () => {
    const steps = getLifecycle(StoryStatus.ReadyForDev);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      workflow: WorkflowType.DevStory,
      agent: AgentType.Sisyphus,
      description: "Develop story",
    });
    expect(steps[1]).toEqual({
      workflow: WorkflowType.CodeReview,
      agent: AgentType.Hephaestus,
      description: "Review code",
    });
  });

  test("in-progress returns 2 steps starting with DevStory", () => {
    const steps = getLifecycle(StoryStatus.InProgress);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      workflow: WorkflowType.DevStory,
      agent: AgentType.Sisyphus,
      description: "Develop story",
    });
    expect(steps[1]).toEqual({
      workflow: WorkflowType.CodeReview,
      agent: AgentType.Hephaestus,
      description: "Review code",
    });
  });

  test("review returns 1 step with CodeReview", () => {
    const steps = getLifecycle(StoryStatus.Review);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      workflow: WorkflowType.CodeReview,
      agent: AgentType.Hephaestus,
      description: "Review code",
    });
  });

  test("done throws StoryCompleteError (sentinel error)", () => {
    expect(() => getLifecycle(StoryStatus.Done)).toThrow(StoryCompleteError);
  });

  test("done StoryCompleteError has correct name", () => {
    try {
      getLifecycle(StoryStatus.Done);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StoryCompleteError);
      expect((err as StoryCompleteError).name).toBe("StoryCompleteError");
    }
  });

  test("needs-human-intervention throws Error with correct message", () => {
    expect(() => getLifecycle(StoryStatus.NeedsHumanIntervention)).toThrow(
      "Story requires human intervention"
    );
  });

  test("needs-human-intervention throws a plain Error, not StoryCompleteError", () => {
    try {
      getLifecycle(StoryStatus.NeedsHumanIntervention);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StoryCompleteError);
    }
  });

  test("ready-for-dev and in-progress return identical steps", () => {
    const readySteps = getLifecycle(StoryStatus.ReadyForDev);
    const inProgressSteps = getLifecycle(StoryStatus.InProgress);
    expect(readySteps).toEqual(inProgressSteps);
  });

  test("each call returns a new array (no shared reference)", () => {
    const steps1 = getLifecycle(StoryStatus.Backlog);
    const steps2 = getLifecycle(StoryStatus.Backlog);
    expect(steps1).not.toBe(steps2);
  });
});

describe("getWorkflowAgent", () => {
  test("sprint-planning maps to sisyphus", () => {
    expect(getWorkflowAgent(WorkflowType.SprintPlanning)).toBe(AgentType.Sisyphus);
  });

  test("create-story maps to sisyphus", () => {
    expect(getWorkflowAgent(WorkflowType.CreateStory)).toBe(AgentType.Sisyphus);
  });

  test("dev-story maps to sisyphus", () => {
    expect(getWorkflowAgent(WorkflowType.DevStory)).toBe(AgentType.Sisyphus);
  });

  test("code-review maps to hephaestus", () => {
    expect(getWorkflowAgent(WorkflowType.CodeReview)).toBe(AgentType.Hephaestus);
  });
});

describe("validateTransition", () => {
  describe("valid transitions", () => {
    test("backlog → ready-for-dev is valid", () => {
      expect(validateTransition(StoryStatus.Backlog, StoryStatus.ReadyForDev)).toBe(true);
    });

    test("ready-for-dev → in-progress is valid", () => {
      expect(validateTransition(StoryStatus.ReadyForDev, StoryStatus.InProgress)).toBe(true);
    });

    test("in-progress → review is valid", () => {
      expect(validateTransition(StoryStatus.InProgress, StoryStatus.Review)).toBe(true);
    });

    test("review → done is valid", () => {
      expect(validateTransition(StoryStatus.Review, StoryStatus.Done)).toBe(true);
    });

    test("review → in-progress is valid (fix loop)", () => {
      expect(validateTransition(StoryStatus.Review, StoryStatus.InProgress)).toBe(true);
    });
  });

  describe("any → needs-human-intervention is always valid", () => {
    test("backlog → needs-human-intervention is valid", () => {
      expect(validateTransition(StoryStatus.Backlog, StoryStatus.NeedsHumanIntervention)).toBe(true);
    });

    test("ready-for-dev → needs-human-intervention is valid", () => {
      expect(validateTransition(StoryStatus.ReadyForDev, StoryStatus.NeedsHumanIntervention)).toBe(true);
    });

    test("in-progress → needs-human-intervention is valid", () => {
      expect(validateTransition(StoryStatus.InProgress, StoryStatus.NeedsHumanIntervention)).toBe(true);
    });

    test("review → needs-human-intervention is valid", () => {
      expect(validateTransition(StoryStatus.Review, StoryStatus.NeedsHumanIntervention)).toBe(true);
    });

    test("done → needs-human-intervention is valid", () => {
      expect(validateTransition(StoryStatus.Done, StoryStatus.NeedsHumanIntervention)).toBe(true);
    });

    test("needs-human-intervention → needs-human-intervention is valid", () => {
      expect(
        validateTransition(StoryStatus.NeedsHumanIntervention, StoryStatus.NeedsHumanIntervention)
      ).toBe(true);
    });
  });

  describe("invalid transitions", () => {
    test("backlog → done is invalid", () => {
      expect(validateTransition(StoryStatus.Backlog, StoryStatus.Done)).toBe(false);
    });

    test("backlog → in-progress is invalid", () => {
      expect(validateTransition(StoryStatus.Backlog, StoryStatus.InProgress)).toBe(false);
    });

    test("backlog → review is invalid", () => {
      expect(validateTransition(StoryStatus.Backlog, StoryStatus.Review)).toBe(false);
    });

    test("ready-for-dev → done is invalid", () => {
      expect(validateTransition(StoryStatus.ReadyForDev, StoryStatus.Done)).toBe(false);
    });

    test("ready-for-dev → backlog is invalid", () => {
      expect(validateTransition(StoryStatus.ReadyForDev, StoryStatus.Backlog)).toBe(false);
    });

    test("in-progress → done is invalid", () => {
      expect(validateTransition(StoryStatus.InProgress, StoryStatus.Done)).toBe(false);
    });

    test("in-progress → backlog is invalid", () => {
      expect(validateTransition(StoryStatus.InProgress, StoryStatus.Backlog)).toBe(false);
    });

    test("done → any is invalid", () => {
      expect(validateTransition(StoryStatus.Done, StoryStatus.Backlog)).toBe(false);
      expect(validateTransition(StoryStatus.Done, StoryStatus.ReadyForDev)).toBe(false);
      expect(validateTransition(StoryStatus.Done, StoryStatus.InProgress)).toBe(false);
      expect(validateTransition(StoryStatus.Done, StoryStatus.Review)).toBe(false);
      expect(validateTransition(StoryStatus.Done, StoryStatus.Done)).toBe(false);
    });

    test("needs-human-intervention → any non-NHI is invalid", () => {
      expect(validateTransition(StoryStatus.NeedsHumanIntervention, StoryStatus.Backlog)).toBe(false);
      expect(validateTransition(StoryStatus.NeedsHumanIntervention, StoryStatus.ReadyForDev)).toBe(false);
      expect(validateTransition(StoryStatus.NeedsHumanIntervention, StoryStatus.InProgress)).toBe(false);
      expect(validateTransition(StoryStatus.NeedsHumanIntervention, StoryStatus.Review)).toBe(false);
      expect(validateTransition(StoryStatus.NeedsHumanIntervention, StoryStatus.Done)).toBe(false);
    });

    test("review → backlog is invalid", () => {
      expect(validateTransition(StoryStatus.Review, StoryStatus.Backlog)).toBe(false);
    });

    test("review → ready-for-dev is invalid", () => {
      expect(validateTransition(StoryStatus.Review, StoryStatus.ReadyForDev)).toBe(false);
    });
  });
});

describe("router.ts purity constraints", () => {
  test("router module has no I/O imports", async () => {
    const routerSource = await Bun.file("src/core/router.ts").text();
    expect(routerSource).not.toMatch(/\bimport\b.*\bfs\b/);
    expect(routerSource).not.toMatch(/\bimport\b.*\bpath\b/);
    expect(routerSource).not.toMatch(/\bimport\b.*\bfetch\b/);
    expect(routerSource).not.toMatch(/\bBun\.file\b/);
    expect(routerSource).not.toMatch(/\bBun\.sql\b/);
    expect(routerSource).not.toMatch(/\bBun\.redis\b/);
  });

  test("router module has no async functions", async () => {
    const routerSource = await Bun.file("src/core/router.ts").text();
    expect(routerSource).not.toMatch(/\basync\s+function\b/);
    expect(routerSource).not.toMatch(/\basync\s+\(/);
  });

  test("router module only imports from types.js and errors.js", async () => {
    const routerSource = await Bun.file("src/core/router.ts").text();
    const importLines = routerSource
      .split("\n")
      .filter((line) => line.trim().startsWith("import"));

    for (const line of importLines) {
      const isTypesImport = line.includes("./types.js");
      const isErrorsImport = line.includes("./errors.js");
      expect(isTypesImport || isErrorsImport).toBe(true);
    }
  });
});
