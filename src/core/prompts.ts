export type WorkflowName =
  | "sprint-planning"
  | "create-story"
  | "dev-story"
  | "code-review";

export const DEFAULT_PROMPTS: Record<WorkflowName, string> = {
  "sprint-planning": `Run the sprint-planning workflow for this BMAD project.
Read the PRD and architecture docs, then create or update the sprint-status.yaml file.
Project directory: {{projectDir}}
Do not ask questions. Complete the workflow fully.`,

  "create-story": `Run the create-story workflow for story {{storyKey}}.
Read the sprint-status.yaml, find the story, and generate the full story file with acceptance criteria and tasks.
Project directory: {{projectDir}}
Do not ask questions. Complete the workflow fully.`,

  "dev-story": `Run the dev-story workflow for story {{storyKey}}.
Read the story file and implement all tasks using TDD. Follow the checklist strictly.
For any tasks marked [AI-Review], note them for the code review step.
Project directory: {{projectDir}}
Do not ask questions. Complete all tasks fully.`,

  "code-review": `Run the code-review workflow for story {{storyKey}}.
Review all code changes for this story against the acceptance criteria and tasks.
If issues are found, choose option 2 to create action items for the developer.
If all checks pass, mark the story as done.
Project directory: {{projectDir}}
Do not ask questions. Always choose to auto-fix all issues immediately.`,
};

export function renderPrompt(
  workflow: WorkflowName,
  variables: Record<string, string>,
  customPrompts?: Partial<Record<WorkflowName, string>>
): string {
  const template =
    (customPrompts && customPrompts[workflow]) ?? DEFAULT_PROMPTS[workflow];

  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]
      : `{{${key}}}`;
  });
}

export function getDefaultPrompts(): Record<WorkflowName, string> {
  return { ...DEFAULT_PROMPTS };
}

export function validatePromptVariables(
  workflow: WorkflowName,
  variables: Record<string, string>
): string[] {
  const template = DEFAULT_PROMPTS[workflow];
  const regex = /\{\{(\w+)\}\}/g;
  const referenced = new Set<string>();
  let match = regex.exec(template);
  while (match !== null) {
    referenced.add(match[1]);
    match = regex.exec(template);
  }

  return Array.from(referenced).filter(
    (varName) => !Object.prototype.hasOwnProperty.call(variables, varName)
  );
}
