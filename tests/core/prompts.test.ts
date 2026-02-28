import { test, expect, describe } from "bun:test";
import {
  DEFAULT_PROMPTS,
  renderPrompt,
  getDefaultPrompts,
  validatePromptVariables,
  type WorkflowName,
} from "../../src/core/prompts";

const ALL_WORKFLOWS: WorkflowName[] = [
  "sprint-planning",
  "create-story",
  "dev-story",
  "code-review",
];

describe("DEFAULT_PROMPTS", () => {
  test("has all 4 workflow entries", () => {
    expect(Object.keys(DEFAULT_PROMPTS)).toHaveLength(4);
    for (const wf of ALL_WORKFLOWS) {
      expect(DEFAULT_PROMPTS[wf]).toBeTruthy();
    }
  });

  test("each default prompt contains 'Do not ask questions'", () => {
    for (const wf of ALL_WORKFLOWS) {
      expect(DEFAULT_PROMPTS[wf]).toContain("Do not ask questions");
    }
  });

  test("code-review prompt instructs to auto-fix all issues immediately", () => {
    expect(DEFAULT_PROMPTS["code-review"]).toContain(
      "auto-fix all issues immediately"
    );
  });
});

describe("renderPrompt", () => {
  test("replaces {{storyKey}} correctly", () => {
    const result = renderPrompt("create-story", { storyKey: "E1-S2", projectDir: "/proj" });
    expect(result).toContain("E1-S2");
    expect(result).not.toContain("{{storyKey}}");
  });

  test("replaces multiple variables ({{storyKey}} + {{projectDir}})", () => {
    const result = renderPrompt("dev-story", {
      storyKey: "E1-S3",
      projectDir: "/my/project",
    });
    expect(result).toContain("E1-S3");
    expect(result).toContain("/my/project");
    expect(result).not.toContain("{{storyKey}}");
    expect(result).not.toContain("{{projectDir}}");
  });

  test("uses custom prompt when provided", () => {
    const customPrompts = {
      "dev-story": "Custom template for {{storyKey}}",
    };
    const result = renderPrompt(
      "dev-story",
      { storyKey: "E2-S1" },
      customPrompts
    );
    expect(result).toBe("Custom template for E2-S1");
  });

  test("falls back to default when no custom provided", () => {
    const result = renderPrompt("sprint-planning", {
      projectDir: "/workspace",
    });
    expect(result).toContain("sprint-planning workflow");
    expect(result).toContain("/workspace");
  });

  test("falls back to default when custom does not override this workflow", () => {
    const customPrompts = {
      "create-story": "Custom create story",
    };
    const result = renderPrompt(
      "sprint-planning",
      { projectDir: "/workspace" },
      customPrompts
    );
    expect(result).toContain("sprint-planning workflow");
  });

  test("leaves unreferenced {{variables}} as-is when not provided", () => {
    const result = renderPrompt("dev-story", { projectDir: "/proj" });
    expect(result).toContain("{{storyKey}}");
    expect(result).toContain("/proj");
  });

  test("replaces all occurrences of same variable", () => {
    const customPrompts = {
      "sprint-planning": "Hello {{name}}! Again, {{name}}!",
    };
    const result = renderPrompt("sprint-planning", { name: "World" }, customPrompts);
    expect(result).toBe("Hello World! Again, World!");
  });
});

describe("getDefaultPrompts", () => {
  test("returns a copy — not a mutable reference", () => {
    const copy = getDefaultPrompts();
    copy["sprint-planning"] = "MUTATED";
    expect(DEFAULT_PROMPTS["sprint-planning"]).not.toBe("MUTATED");
  });

  test("returned copy contains all 4 workflows", () => {
    const copy = getDefaultPrompts();
    expect(Object.keys(copy)).toHaveLength(4);
    for (const wf of ALL_WORKFLOWS) {
      expect(copy[wf]).toBeTruthy();
    }
  });
});

describe("validatePromptVariables", () => {
  test("returns missing variable names when vars not provided", () => {
    const missing = validatePromptVariables("create-story", {});
    expect(missing).toContain("storyKey");
    expect(missing).toContain("projectDir");
  });

  test("returns empty array when all required vars present", () => {
    const missing = validatePromptVariables("create-story", {
      storyKey: "E1-S1",
      projectDir: "/proj",
    });
    expect(missing).toHaveLength(0);
  });

  test("returns only missing vars when some are provided", () => {
    const missing = validatePromptVariables("dev-story", {
      projectDir: "/proj",
    });
    expect(missing).toContain("storyKey");
    expect(missing).not.toContain("projectDir");
  });

  test("sprint-planning only requires projectDir", () => {
    const missing = validatePromptVariables("sprint-planning", {
      projectDir: "/proj",
    });
    expect(missing).toHaveLength(0);
  });

  test("sprint-planning returns projectDir as missing when absent", () => {
    const missing = validatePromptVariables("sprint-planning", {});
    expect(missing).toContain("projectDir");
  });
});
