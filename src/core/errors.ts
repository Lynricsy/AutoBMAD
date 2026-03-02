import { WorkflowType } from "./types.js";

export class StoryCompleteError extends Error {
  readonly storyKey: string;

  constructor(storyKey: string) {
    super(`Story ${storyKey} is already complete`);
    this.name = "StoryCompleteError";
    this.storyKey = storyKey;
  }
}

export class MaxRetriesExceededError extends Error {
  readonly storyKey: string;
  readonly maxRetries: number;

  constructor(storyKey: string, maxRetries: number) {
    super(`Story ${storyKey} exceeded max retries (${maxRetries})`);
    this.name = "MaxRetriesExceededError";
    this.storyKey = storyKey;
    this.maxRetries = maxRetries;
  }
}

export class WorkflowHaltError extends Error {
  readonly storyKey: string;
  readonly workflow: WorkflowType;
  readonly reason: string;

  constructor(storyKey: string, workflow: WorkflowType, reason: string) {
    super(`Workflow ${workflow} halted for story ${storyKey}: ${reason}`);
    this.name = "WorkflowHaltError";
    this.storyKey = storyKey;
    this.workflow = workflow;
    this.reason = reason;
  }
}

export class StateCorruptionError extends Error {
  readonly filePath: string;
  readonly details: string;

  constructor(filePath: string, details: string) {
    super(`State corruption detected in ${filePath}: ${details}`);
    this.name = "StateCorruptionError";
    this.filePath = filePath;
    this.details = details;
  }
}

export class ProjectCompleteError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Project complete: ${reason}`);
    this.name = "ProjectCompleteError";
    this.reason = reason;
  }
}

export class MaxSprintsExceededError extends Error {
  readonly maxSprints: number;

  constructor(maxSprints: number) {
    super(`Maximum sprints exceeded (${maxSprints})`);
    this.name = "MaxSprintsExceededError";
    this.maxSprints = maxSprints;
  }
}

export class DuplicateStoriesError extends Error {
  readonly sprintNumber: number;
  readonly duplicateKeys: string[];

  constructor(sprintNumber: number, duplicateKeys: string[]) {
    super(`Sprint ${sprintNumber} generated duplicate stories: ${duplicateKeys.join(", ")}`);
    this.name = "DuplicateStoriesError";
    this.sprintNumber = sprintNumber;
    this.duplicateKeys = duplicateKeys;
  }
}
