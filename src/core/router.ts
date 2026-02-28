import { StoryStatus, WorkflowType, AgentType, type LifecycleStep } from "./types.js";
import { StoryCompleteError } from "./errors.js";

// 核心路由函数：根据故事状态返回剩余生命周期步骤
export function getLifecycle(status: StoryStatus): LifecycleStep[] {
  switch (status) {
    case StoryStatus.Backlog:
      return [
        {
          workflow: WorkflowType.CreateStory,
          agent: AgentType.Sisyphus,
          description: "Create story file",
        },
        {
          workflow: WorkflowType.DevStory,
          agent: AgentType.Sisyphus,
          description: "Develop story",
        },
        {
          workflow: WorkflowType.CodeReview,
          agent: AgentType.Hephaestus,
          description: "Review code",
        },
      ];

    case StoryStatus.ReadyForDev:
    case StoryStatus.InProgress:
      return [
        {
          workflow: WorkflowType.DevStory,
          agent: AgentType.Sisyphus,
          description: "Develop story",
        },
        {
          workflow: WorkflowType.CodeReview,
          agent: AgentType.Hephaestus,
          description: "Review code",
        },
      ];

    case StoryStatus.Review:
      return [
        {
          workflow: WorkflowType.CodeReview,
          agent: AgentType.Hephaestus,
          description: "Review code",
        },
      ];

    case StoryStatus.Done:
      throw new StoryCompleteError("story");

    case StoryStatus.NeedsHumanIntervention:
      throw new Error("Story requires human intervention");

    default: {
      // 穷举检查：TypeScript 确保所有状态都被处理
      const _exhaustive: never = status;
      throw new Error(`Unknown story status: ${_exhaustive}`);
    }
  }
}

// Agent 映射函数：根据工作流类型返回对应的 Agent
export function getWorkflowAgent(workflow: WorkflowType): AgentType {
  switch (workflow) {
    case WorkflowType.SprintPlanning:
      return AgentType.Sisyphus;

    case WorkflowType.CreateStory:
      return AgentType.Sisyphus;

    case WorkflowType.DevStory:
      return AgentType.Sisyphus;

    case WorkflowType.CodeReview:
      return AgentType.Hephaestus;

    default: {
      // 穷举检查：TypeScript 确保所有工作流类型都被处理
      const _exhaustive: never = workflow;
      throw new Error(`Unknown workflow type: ${_exhaustive}`);
    }
  }
}

// 状态转换验证函数：验证故事状态转换是否合法
export function validateTransition(from: StoryStatus, to: StoryStatus): boolean {
  // 任何状态都可以转换为需要人工干预
  if (to === StoryStatus.NeedsHumanIntervention) {
    return true;
  }

  switch (from) {
    case StoryStatus.Backlog:
      return to === StoryStatus.ReadyForDev;

    case StoryStatus.ReadyForDev:
      return to === StoryStatus.InProgress;

    case StoryStatus.InProgress:
      return to === StoryStatus.Review;

    case StoryStatus.Review:
      // 代码审查通过 → 完成，或审查失败 → 回到开发
      return to === StoryStatus.Done || to === StoryStatus.InProgress;

    case StoryStatus.Done:
      return false;

    case StoryStatus.NeedsHumanIntervention:
      return false;

    default: {
      // 穷举检查
      const _exhaustive: never = from;
      throw new Error(`Unknown story status: ${_exhaustive}`);
    }
  }
}
