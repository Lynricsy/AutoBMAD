import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { SprintStatusManager } from "../../src/core/state-manager.js";
import { StoryStatus } from "../../src/core/types.js";
import { StateCorruptionError } from "../../src/core/errors.js";

const FIXTURE_YAML = `# generated: 2026-02-28
# project: AgentLoomBMAD
# project_key: NOKEY
# tracking_system: file-system
# story_location: {project-root}/_bmad-output/implementation-artifacts

generated: 2026-02-28
project: AgentLoomBMAD
project_key: NOKEY
tracking_system: file-system
story_location: "{project-root}/_bmad-output/implementation-artifacts"

development_status:
  # Epic 0: 项目启动
  epic-0: in-progress
  0-1-backend-service-init: review
  0-2-type-engine-init: in-progress
  0-3-web-frontend-init: ready-for-dev
  0-4-mobile-init: backlog
  epic-0-retrospective: optional
`;

describe("SprintStatusManager", () => {
  let tmpDir: string;
  let statusFilePath: string;
  let manager: SprintStatusManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobmad-state-manager-test-"));
    statusFilePath = join(tmpDir, "sprint-status.yaml");
    writeFileSync(statusFilePath, FIXTURE_YAML, "utf-8");
    manager = new SprintStatusManager(statusFilePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("readStatus parses flat YAML structure", async () => {
    const status = await manager.readStatus();

    expect(status.generated).toBe("2026-02-28");
    expect(status.project).toBe("AgentLoomBMAD");
    expect(status.project_key).toBe("NOKEY");
    expect(status.tracking_system).toBe("file-system");
    expect(status.story_location).toBe("{project-root}/_bmad-output/implementation-artifacts");

    expect(status.development_status["epic-0"]).toBe("in-progress");
    expect(status.development_status["0-2-type-engine-init"]).toBe("in-progress");
  });

  test("getAllStories returns only story entries", async () => {
    const stories = await manager.getAllStories();

    expect(stories.size).toBe(4);
    expect(stories.has("epic-0")).toBe(false);
    expect(stories.has("epic-0-retrospective")).toBe(false);

    expect(stories.get("0-1-backend-service-init")).toBe(StoryStatus.Review);
    expect(stories.get("0-2-type-engine-init")).toBe(StoryStatus.InProgress);
    expect(stories.get("0-3-web-frontend-init")).toBe(StoryStatus.ReadyForDev);
    expect(stories.get("0-4-mobile-init")).toBe(StoryStatus.Backlog);
  });

  test("getNextStory respects priority ordering", async () => {
    expect(await manager.getNextStory()).toBe("0-2-type-engine-init");

    await manager.updateStatus("0-2-type-engine-init", StoryStatus.Done);
    expect(await manager.getNextStory()).toBe("0-1-backend-service-init");

    await manager.updateStatus("0-1-backend-service-init", StoryStatus.Done);
    expect(await manager.getNextStory()).toBe("0-3-web-frontend-init");

    await manager.updateStatus("0-3-web-frontend-init", StoryStatus.Done);
    expect(await manager.getNextStory()).toBe("0-4-mobile-init");

    await manager.updateStatus("0-4-mobile-init", StoryStatus.Done);
    expect(await manager.getNextStory()).toBeNull();
  });

  test("isSprintComplete returns false when stories remain, true when all done", async () => {
    expect(await manager.isSprintComplete()).toBe(false);

    await manager.updateStatus("0-1-backend-service-init", StoryStatus.Done);
    await manager.updateStatus("0-2-type-engine-init", StoryStatus.Done);
    await manager.updateStatus("0-3-web-frontend-init", StoryStatus.Done);
    await manager.updateStatus("0-4-mobile-init", StoryStatus.Done);

    expect(await manager.isSprintComplete()).toBe(true);
  });

  test("updateStatus updates only the target story and preserves comments", async () => {
    const before = await manager.readStatus();
    const beforeText = readFileSync(statusFilePath, "utf-8");
    expect(beforeText).toContain("# Epic 0: 项目启动");

    await manager.updateStatus("0-1-backend-service-init", StoryStatus.Done);

    const after = await manager.readStatus();
    const afterText = readFileSync(statusFilePath, "utf-8");

    expect(afterText).toContain("# generated: 2026-02-28");
    expect(afterText).toContain("# Epic 0: 项目启动");
    expect(afterText).toContain("0-1-backend-service-init: done");

    for (const [key, value] of Object.entries(before.development_status)) {
      if (key === "0-1-backend-service-init") continue;
      expect(after.development_status[key]).toBe(value);
    }
  });

  test("updateStatus leaves no .tmp file after atomic write", async () => {
    await manager.updateStatus("0-4-mobile-init", StoryStatus.InProgress);
    expect(existsSync(`${statusFilePath}.tmp`)).toBe(false);
  });

  test("file not found throws StateCorruptionError", async () => {
    const missing = join(tmpDir, "missing.yaml");
    const missingManager = new SprintStatusManager(missing);

    try {
      await missingManager.readStatus();
      throw new Error("expected readStatus to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StateCorruptionError);
      if (err instanceof StateCorruptionError) {
        expect(err.filePath).toBe(missing);
      }
    }
  });

  test("malformed YAML throws StateCorruptionError", async () => {
    writeFileSync(statusFilePath, "generated: 2026-02-28\nproject: [oops\n", "utf-8");

    try {
      await manager.readStatus();
      throw new Error("expected readStatus to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StateCorruptionError);
      if (err instanceof StateCorruptionError) {
        expect(err.filePath).toBe(statusFilePath);
      }
    }
  });
});
