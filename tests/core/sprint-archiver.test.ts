import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SprintArchiver } from "../../src/core/sprint-archiver.js";

describe("SprintArchiver", () => {
  let tmpDir: string;
  let artifactsDir: string;
  let archiver: SprintArchiver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobmad-sprint-archiver-test-"));
    artifactsDir = join(tmpDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    archiver = new SprintArchiver(artifactsDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("archive() copies active sprint status and preserves content", async () => {
    const activePath = archiver.getActiveStatusPath();
    const archivePath = archiver.getArchivePath(1);
    const yamlContent = "generated: 2026-03-01\ndevelopment_status:\n  1-1-foo: done\n";

    await Bun.write(activePath, yamlContent);
    await archiver.archive(1);

    expect(await Bun.file(archivePath).exists()).toBe(true);
    expect(await Bun.file(activePath).exists()).toBe(true);
    expect(await Bun.file(archivePath).text()).toBe(yamlContent);
    expect(await Bun.file(activePath).text()).toBe(yamlContent);
  });

  test("archive() throws when archive already exists", async () => {
    const activePath = archiver.getActiveStatusPath();
    const archivePath = archiver.getArchivePath(2);

    await Bun.write(activePath, "generated: active\n");
    await Bun.write(archivePath, "generated: archive\n");

    try {
      await archiver.archive(2);
      throw new Error("expected archive() to throw when archive already exists");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      if (err instanceof Error) {
        expect(err.message).toContain("Archive already exists");
      }
    }
  });

  test("archive() throws when active sprint-status.yaml does not exist", async () => {
    try {
      await archiver.archive(3);
      throw new Error("expected archive() to throw when active status is missing");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      if (err instanceof Error) {
        expect(err.message).toContain("Active sprint status file not found");
      }
    }
  });

  test("getArchivePath() returns sprint-specific archive path", () => {
    expect(archiver.getArchivePath(7)).toBe(join(artifactsDir, "sprint-7-status.yaml"));
  });

  test("getActiveStatusPath() returns active status path", () => {
    expect(archiver.getActiveStatusPath()).toBe(join(artifactsDir, "sprint-status.yaml"));
  });

  test("hasArchive() returns true when archive exists and false otherwise", async () => {
    const sprintNumber = 5;
    expect(await archiver.hasArchive(sprintNumber)).toBe(false);

    await Bun.write(archiver.getArchivePath(sprintNumber), "generated: 2026-03-01\n");
    expect(await archiver.hasArchive(sprintNumber)).toBe(true);
  });
});
