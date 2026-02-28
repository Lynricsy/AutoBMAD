import { parseDocument } from "yaml";
import { renameSync, writeFileSync } from "node:fs";
import { type IStateRepository, type SprintStatusData, StoryStatus } from "./types.js";
import { StateCorruptionError } from "./errors.js";

const STORY_KEY_RE = /^\d+-\d+-/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string") {
    throw new StateCorruptionError(filePath, `${field} must be a string`);
  }
  return value;
}

function expectStringRecord(
  value: unknown,
  field: string,
  filePath: string,
): Record<string, string> {
  if (!isRecord(value)) {
    throw new StateCorruptionError(filePath, `${field} must be a mapping`);
  }

  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new StateCorruptionError(filePath, `${field}.${k} must be a string`);
    }
    result[k] = v;
  }
  return result;
}

function parseSprintStatusData(value: unknown, filePath: string): SprintStatusData {
  if (!isRecord(value)) {
    throw new StateCorruptionError(filePath, "root must be a mapping");
  }

  return {
    generated: expectString(value.generated, "generated", filePath),
    project: expectString(value.project, "project", filePath),
    project_key: expectString(value.project_key, "project_key", filePath),
    tracking_system: expectString(value.tracking_system, "tracking_system", filePath),
    story_location: expectString(value.story_location, "story_location", filePath),
    development_status: expectStringRecord(value.development_status, "development_status", filePath),
  };
}

const STORY_STATUS_SET = new Set<string>(Object.values(StoryStatus));

function parseStoryStatus(value: string, storyKey: string, filePath: string): StoryStatus {
  if (!STORY_STATUS_SET.has(value)) {
    throw new StateCorruptionError(filePath, `invalid story status for ${storyKey}: ${value}`);
  }
  return value as StoryStatus;
}

function isStoryKey(key: string): boolean {
  return STORY_KEY_RE.test(key);
}

export class SprintStatusManager implements IStateRepository {
  readonly statusFilePath: string;

  constructor(statusFilePath: string) {
    this.statusFilePath = statusFilePath;
  }

  private async loadYamlText(): Promise<string> {
    const file = Bun.file(this.statusFilePath);

    const exists = await file.exists();
    if (!exists) {
      throw new StateCorruptionError(this.statusFilePath, "file not found");
    }

    try {
      return await file.text();
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      throw new StateCorruptionError(this.statusFilePath, details);
    }
  }

  private async loadDocument() {
    const text = await this.loadYamlText();

    try {
      const doc = parseDocument(text, { prettyErrors: true });

      if (doc.errors && doc.errors.length > 0) {
        const details = doc.errors.map((e) => e.message).join("; ");
        throw new StateCorruptionError(this.statusFilePath, details || "YAML parse error");
      }

      return doc;
    } catch (err) {
      if (err instanceof StateCorruptionError) throw err;
      const details = err instanceof Error ? err.message : String(err);
      throw new StateCorruptionError(this.statusFilePath, details);
    }
  }

  async readStatus(): Promise<SprintStatusData> {
    const doc = await this.loadDocument();
    const raw: unknown = doc.toJS();
    return parseSprintStatusData(raw, this.statusFilePath);
  }

  async updateStatus(storyKey: string, status: StoryStatus): Promise<void> {
    const doc = await this.loadDocument();

    const raw: unknown = doc.toJS();
    parseSprintStatusData(raw, this.statusFilePath);

    try {
      doc.setIn(["development_status", storyKey], status);
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      throw new StateCorruptionError(this.statusFilePath, details);
    }

    const yamlString = doc.toString();
    const tmpPath = `${this.statusFilePath}.tmp`;

    writeFileSync(tmpPath, yamlString, "utf-8");
    renameSync(tmpPath, this.statusFilePath);
  }

  async getNextStory(): Promise<string | null> {
    const status = await this.readStatus();
    const storyEntries = Object.entries(status.development_status).filter(([key]) => isStoryKey(key));

    const priority: StoryStatus[] = [
      StoryStatus.InProgress,
      StoryStatus.Review,
      StoryStatus.ReadyForDev,
      StoryStatus.Backlog,
    ];

    for (const wanted of priority) {
      for (const [key, rawStatus] of storyEntries) {
        const st = parseStoryStatus(rawStatus, key, this.statusFilePath);
        if (st === wanted) return key;
      }
    }

    return null;
  }

  async getAllStories(): Promise<Map<string, StoryStatus>> {
    const status = await this.readStatus();
    const stories = new Map<string, StoryStatus>();

    for (const [key, rawStatus] of Object.entries(status.development_status)) {
      if (!isStoryKey(key)) continue;
      stories.set(key, parseStoryStatus(rawStatus, key, this.statusFilePath));
    }

    return stories;
  }

  async isSprintComplete(): Promise<boolean> {
    const stories = await this.getAllStories();
    for (const st of stories.values()) {
      if (st !== StoryStatus.Done) return false;
    }
    return true;
  }
}
