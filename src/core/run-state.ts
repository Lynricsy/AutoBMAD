import { renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { StateCorruptionError } from "./errors.js";
import {
  WorkflowType,
  type ErrorInfo,
  type IRunStateStore,
  type RunState,
} from "./types.js";

function createDefaultRunState(now: Date = new Date()): RunState {
  return {
    currentStory: null,
    retries: {},
    errors: [],
    startedAt: now,
    lastUpdatedAt: now,
    completedStories: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDate(value: unknown, filePath: string, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value !== "string") {
    throw new StateCorruptionError(filePath, `Invalid ${field}: expected ISO string`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new StateCorruptionError(filePath, `Invalid ${field}: not a valid date`);
  }
  return parsed;
}

function isWorkflowType(value: unknown): value is WorkflowType {
  return (
    value === WorkflowType.SprintPlanning ||
    value === WorkflowType.CreateStory ||
    value === WorkflowType.DevStory ||
    value === WorkflowType.CodeReview
  );
}

function hydrateErrorInfo(value: unknown, filePath: string): ErrorInfo {
  if (!isRecord(value)) {
    throw new StateCorruptionError(filePath, "Invalid errors entry: expected object");
  }

  if (typeof value.message !== "string") {
    throw new StateCorruptionError(filePath, "Invalid errors entry: missing message");
  }
  if (typeof value.code !== "string") {
    throw new StateCorruptionError(filePath, "Invalid errors entry: missing code");
  }

  const error: ErrorInfo = {
    message: value.message,
    code: value.code,
    timestamp: parseDate(value.timestamp, filePath, "errors[].timestamp"),
  };

  if (typeof value.storyKey === "string") error.storyKey = value.storyKey;
  if (typeof value.stack === "string") error.stack = value.stack;
  if (isWorkflowType(value.workflow)) error.workflow = value.workflow;

  return error;
}

function hydrateRunState(value: unknown, filePath: string): RunState {
  if (!isRecord(value)) {
    throw new StateCorruptionError(filePath, "Invalid state: expected object");
  }

  const currentStoryRaw = value.currentStory;
  if (currentStoryRaw !== null && typeof currentStoryRaw !== "string") {
    throw new StateCorruptionError(filePath, "Invalid currentStory: expected string or null");
  }
  const currentStory: string | null = currentStoryRaw;

  const retriesRaw = value.retries;
  if (!isRecord(retriesRaw)) {
    throw new StateCorruptionError(filePath, "Invalid retries: expected object");
  }
  const retries: Record<string, number> = {};
  for (const [key, count] of Object.entries(retriesRaw)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      throw new StateCorruptionError(filePath, `Invalid retries.${key}: expected non-negative number`);
    }
    retries[key] = count;
  }

  const errorsRaw = value.errors;
  if (!Array.isArray(errorsRaw)) {
    throw new StateCorruptionError(filePath, "Invalid errors: expected array");
  }
  const errors = errorsRaw.map((err) => hydrateErrorInfo(err, filePath));

  const completedRaw = value.completedStories;
  if (!Array.isArray(completedRaw) || completedRaw.some((s) => typeof s !== "string")) {
    throw new StateCorruptionError(filePath, "Invalid completedStories: expected string[]");
  }
  const completedStories = completedRaw;

  const startedAt = parseDate(value.startedAt, filePath, "startedAt");
  const lastUpdatedAt = parseDate(value.lastUpdatedAt, filePath, "lastUpdatedAt");

  return {
    currentStory,
    retries,
    errors,
    startedAt,
    lastUpdatedAt,
    completedStories,
  };
}

export class RunStateStore implements IRunStateStore {
  private readonly statePath: string;
  private state: RunState;

  constructor(statePath: string = join(process.cwd(), ".autobmad-state.json")) {
    this.statePath = statePath;
    this.state = createDefaultRunState();
  }

  async load(): Promise<RunState> {
    const file = Bun.file(this.statePath);
    const exists = await file.exists();
    if (!exists) {
      this.state = createDefaultRunState();
      await this.save(this.state);
      return this.state;
    }

    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new StateCorruptionError(this.statePath, `Invalid JSON: ${message}`);
    }

    this.state = hydrateRunState(parsed, this.statePath);
    return this.state;
  }

  save(state: RunState): Promise<void> {
    const now = new Date();
    state.lastUpdatedAt = now;
    this.state = state;

    const tmpPath = `${this.statePath}.tmp`;
    const json = JSON.stringify(state, null, 2);

    try {
      writeFileSync(tmpPath, json, "utf-8");
      renameSync(tmpPath, this.statePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
      }
      throw err;
    }

    return Promise.resolve();
  }

  getRetryCount(storyKey: string): number {
    return this.state.retries[storyKey] ?? 0;
  }

  incrementRetry(storyKey: string): void {
    const current = this.state.retries[storyKey] ?? 0;
    this.state.retries[storyKey] = current + 1;
    void this.save(this.state);
  }

  setError(error: ErrorInfo): void {
    this.state.errors.push(error);
    void this.save(this.state);
  }

  clearStory(): void {
    this.state.currentStory = null;
    void this.save(this.state);
  }

  markComplete(storyKey: string): void {
    if (!this.state.completedStories.includes(storyKey)) {
      this.state.completedStories.push(storyKey);
    }

    delete this.state.retries[storyKey];
    this.state.currentStory = null;
    void this.save(this.state);
  }

  async reset(): Promise<void> {
    this.state = createDefaultRunState();
    await this.save(this.state);
  }
}
