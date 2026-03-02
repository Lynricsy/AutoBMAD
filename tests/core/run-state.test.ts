import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStateStore } from "../../src/core/run-state.js";
import { WorkflowType, type RunState } from "../../src/core/types.js";

describe("RunStateStore", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autobmad-runstate-test-"));
    statePath = join(tmpDir, ".autobmad-state.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("load() returns default state when file does not exist", async () => {
    const store = new RunStateStore(statePath);

    const state = await store.load();

    expect(state.currentStory).toBeNull();
    expect(state.retries).toEqual({});
    expect(state.errors).toEqual([]);
    expect(state.completedStories).toEqual([]);
    expect(state.startedAt).toBeInstanceOf(Date);
    expect(state.lastUpdatedAt).toBeInstanceOf(Date);
    expect(existsSync(statePath)).toBe(true);
  });

  test("save() -> load() roundtrip preserves fields and updates lastUpdatedAt", async () => {
    const store = new RunStateStore(statePath);

    const startedAt = new Date("2020-01-01T00:00:00.000Z");
    const oldLastUpdatedAt = new Date("2000-01-01T00:00:00.000Z");

    const toSave: RunState = {
      currentStory: "STORY-1",
      retries: { "STORY-1": 2 },
      errors: [],
      startedAt,
      lastUpdatedAt: oldLastUpdatedAt,
      completedStories: ["STORY-0"],
    };

    await store.save(toSave);

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentStory).toBe("STORY-1");
    expect(loaded.retries).toEqual({ "STORY-1": 2 });
    expect(loaded.completedStories).toEqual(["STORY-0"]);
    expect(loaded.startedAt.toISOString()).toBe(startedAt.toISOString());
    expect(loaded.lastUpdatedAt.getTime()).toBeGreaterThan(oldLastUpdatedAt.getTime());
  });

  test("dates are serialized as ISO strings and hydrated back to Date", async () => {
    const store = new RunStateStore(statePath);

    const startedAt = new Date("2021-02-03T04:05:06.000Z");
    const errorTimestamp = new Date("2022-03-04T05:06:07.000Z");

    const toSave: RunState = {
      currentStory: null,
      retries: {},
      errors: [
        {
          message: "boom",
          code: "E_BANG",
          timestamp: errorTimestamp,
          storyKey: "STORY-2",
          workflow: WorkflowType.DevStory,
          stack: "stack",
        },
      ],
      startedAt,
      lastUpdatedAt: new Date("2000-01-01T00:00:00.000Z"),
      completedStories: [],
    };

    await store.save(toSave);

    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as {
      startedAt: unknown;
      lastUpdatedAt: unknown;
      errors: Array<{ timestamp: unknown }>;
    };

    expect(typeof raw.startedAt).toBe("string");
    expect(typeof raw.lastUpdatedAt).toBe("string");
    expect(typeof raw.errors[0]?.timestamp).toBe("string");

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.startedAt).toBeInstanceOf(Date);
    expect(loaded.lastUpdatedAt).toBeInstanceOf(Date);
    expect(loaded.errors[0]?.timestamp).toBeInstanceOf(Date);
    expect(loaded.errors[0]?.timestamp.toISOString()).toBe(errorTimestamp.toISOString());
    expect(loaded.errors[0]?.workflow).toBe(WorkflowType.DevStory);
  });

  test("getRetryCount() returns 0 for unknown story", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    expect(store.getRetryCount("STORY-unknown")).toBe(0);
  });

  test("incrementRetry() increments 0 -> 1 -> 2 -> 3", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    store.incrementRetry("STORY-1");
    store.incrementRetry("STORY-1");
    store.incrementRetry("STORY-1");
    expect(store.getRetryCount("STORY-1")).toBe(3);

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.retries["STORY-1"]).toBe(3);
  });

  test("setError() appends error info and persists", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    const timestamp = new Date("2020-01-01T00:00:00.000Z");
    store.setError({
      message: "failed",
      code: "E_FAIL",
      timestamp,
      storyKey: "STORY-9",
      workflow: WorkflowType.CodeReview,
      stack: "stack",
    });

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toMatchObject({
      message: "failed",
      code: "E_FAIL",
      storyKey: "STORY-9",
      workflow: WorkflowType.CodeReview,
      stack: "stack",
    });
    expect(loaded.errors[0]?.timestamp.toISOString()).toBe(timestamp.toISOString());
  });

  test("markComplete() adds to completedStories, clears retries, and clears currentStory", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    await store.save({
      currentStory: "STORY-1",
      retries: { "STORY-1": 2, "STORY-2": 1 },
      errors: [],
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastUpdatedAt: new Date("2000-01-01T00:00:00.000Z"),
      completedStories: [],
    });

    store.markComplete("STORY-1");

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.completedStories).toEqual(["STORY-1"]);
    expect(loaded.retries["STORY-1"]).toBeUndefined();
    expect(loaded.retries["STORY-2"]).toBe(1);
    expect(loaded.currentStory).toBeNull();
  });

  test("clearStory() sets currentStory to null", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    await store.save({
      currentStory: "STORY-1",
      retries: {},
      errors: [],
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastUpdatedAt: new Date("2000-01-01T00:00:00.000Z"),
      completedStories: [],
    });

    store.clearStory();

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentStory).toBeNull();
  });

  test("reset() clears all state and writes file", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    await store.save({
      currentStory: "STORY-1",
      retries: { "STORY-1": 2 },
      errors: [
        {
          message: "boom",
          code: "E_BANG",
          timestamp: new Date("2020-01-01T00:00:00.000Z"),
        },
      ],
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastUpdatedAt: new Date("2000-01-01T00:00:00.000Z"),
      completedStories: ["STORY-0"],
    });

    await store.reset();

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentStory).toBeNull();
    expect(loaded.retries).toEqual({});
    expect(loaded.errors).toEqual([]);
    expect(loaded.completedStories).toEqual([]);
    expect(existsSync(statePath)).toBe(true);
  });

  test("atomic write leaves no .tmp file after successful write", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    await store.save({
      currentStory: null,
      retries: {},
      errors: [],
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastUpdatedAt: new Date("2000-01-01T00:00:00.000Z"),
      completedStories: [],
    });

    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  });

  test("load() returns currentSprint: 1 as default when file does not exist", async () => {
    const store = new RunStateStore(statePath);
    const state = await store.load();
    expect(state.currentSprint).toBe(1);
  });

  test("hydrateRunState() parses currentSprint from JSON correctly", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    await store.save({
      currentStory: null,
      retries: {},
      errors: [],
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastUpdatedAt: new Date("2000-01-01T00:00:00.000Z"),
      completedStories: [],
      currentSprint: 3,
    });

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentSprint).toBe(3);
  });

  test("hydrateRunState() defaults currentSprint to 1 for old state files without it", async () => {
    const { writeFileSync } = await import("node:fs");
    const oldState = {
      currentStory: null,
      retries: {},
      errors: [],
      startedAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      lastUpdatedAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      completedStories: [],
    };
    writeFileSync(statePath, JSON.stringify(oldState, null, 2), "utf-8");

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentSprint).toBe(1);
  });

  test("hydrateRunState() defaults currentSprint to 1 for invalid values", async () => {
    const { writeFileSync } = await import("node:fs");
    const badState = {
      currentStory: null,
      retries: {},
      errors: [],
      startedAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      lastUpdatedAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      completedStories: [],
      currentSprint: -5,
    };
    writeFileSync(statePath, JSON.stringify(badState, null, 2), "utf-8");

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentSprint).toBe(1);
  });

  test("setCurrentSprint() updates currentSprint and persists", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    store.setCurrentSprint(4);

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentSprint).toBe(4);
  });

  test("reset() resets currentSprint to 1", async () => {
    const store = new RunStateStore(statePath);
    await store.load();

    store.setCurrentSprint(7);
    await store.reset();

    const loaded = await new RunStateStore(statePath).load();
    expect(loaded.currentSprint).toBe(1);
  });
});
