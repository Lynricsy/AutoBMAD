// 核心枚举：故事状态
export enum StoryStatus {
  Backlog = "backlog",
  ReadyForDev = "ready-for-dev",
  InProgress = "in-progress",
  Review = "review",
  Done = "done",
  NeedsHumanIntervention = "needs-human-intervention",
}

// 核心枚举：Epic 状态
export enum EpicStatus {
  Backlog = "backlog",
  InProgress = "in-progress",
  Done = "done",
}

// 核心枚举：工作流类型
export enum WorkflowType {
  SprintPlanning = "sprint-planning",
  CreateStory = "create-story",
  DevStory = "dev-story",
  CodeReview = "code-review",
}

// 核心枚举：Agent 类型
export enum AgentType {
  Sisyphus = "sisyphus",
  Hephaestus = "hephaestus",
}

// 项目完成原因
export enum ProjectCompleteReason {
  NoNewStories = "no-new-stories",
  MaxSprintsReached = "max-sprints-reached",
  DuplicateStoriesDetected = "duplicate-stories-detected",
}

// Sprint 状态 YAML 数据结构（匹配真实 sprint-status.yaml 格式）
export interface SprintStatusData {
  generated: string;
  project: string;
  project_key: string;
  tracking_system: string;
  story_location: string;
  development_status: Record<string, string>;
}

// 路由器生命周期步骤
export interface LifecycleStep {
  workflow: WorkflowType;
  agent: AgentType;
  description: string;
}

// oh-my-opencode 运行结果
export interface RunResult {
  sessionId: string;
  success: boolean;
  durationMs: number;
  messageCount: number;
  summary: string;
}

// oh-my-opencode 运行选项
export interface RunOptions {
  message: string;
  agent: AgentType;
  directory: string;
  timeout?: number;
}

// 故事处理结果
export interface StoryResult {
  storyKey: string;
  success: boolean;
  retries: number;
  error?: ErrorInfo;
  durationMs: number;
}

// Sprint 处理结果
export interface SprintResult {
  status: "complete" | "paused" | "failed";
  totalStories: number;
  completed: number;
  failed: number;
  skipped: number;
  results: StoryResult[];
  durationMs: number;
}

// 多 Sprint 配置
export interface MultiSprintConfig {
  maxSprints: number;
}

// 多 Sprint 运行结果
export interface MultiSprintResult {
  reason: ProjectCompleteReason;
  totalSprints: number;
  sprintResults: SprintResult[];
  durationMs: number;
}

// 错误信息（用于日志/报告）
export interface ErrorInfo {
  message: string;
  code: string;
  timestamp: Date;
  storyKey?: string;
  workflow?: WorkflowType;
  stack?: string;
}

// 配置
export interface AutoBMADConfig {
  projectDir: string;
  maxRetries: number;
  timeout: number;
  verbose: boolean;
  configPath?: string;
  prompts?: Partial<Record<WorkflowType, string>>;
  maxSprints?: number;
}

// 运行状态（支持断点续跑）
export interface RunState {
  currentStory: string | null;
  retries: Record<string, number>;
  errors: ErrorInfo[];
  startedAt: Date;
  lastUpdatedAt: Date;
  completedStories: string[];
  currentSprint?: number;
}

// 依赖注入接口：状态仓库
export interface IStateRepository {
  readStatus(): Promise<SprintStatusData>;
  updateStatus(storyKey: string, status: StoryStatus): Promise<void>;
  getNextStory(): Promise<string | null>;
  getAllStories(): Promise<Map<string, StoryStatus>>;
  isSprintComplete(): Promise<boolean>;
}

// 依赖注入接口：工作流运行器
export interface IWorkflowRunner {
  run(options: RunOptions): Promise<RunResult>;
}

// 依赖注入接口：运行状态存储
export interface IRunStateStore {
  load(): Promise<RunState>;
  save(state: RunState): Promise<void>;
  getRetryCount(storyKey: string): number;
  incrementRetry(storyKey: string): void;
  setError(error: ErrorInfo): void;
  clearStory(): void;
  markComplete(storyKey: string): void;
  setCurrentSprint(sprint: number): void;
  reset(): Promise<void>;
}
