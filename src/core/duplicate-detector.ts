const STORY_KEY_RE = /^\d+-\d+[a-zA-Z]*-/;

export interface DuplicateResult {
  isDuplicate: boolean;
  duplicateKeys: string[];
  overlapPercentage: number;
}

export function stripSprintPrefix(key: string): string {
  return key.replace(STORY_KEY_RE, "");
}

export function detectDuplicateStories(
  previousKeys: string[],
  currentKeys: string[],
): DuplicateResult {
  const previousDescriptions = new Set(previousKeys.map(stripSprintPrefix));

  const duplicateKeys = currentKeys.filter((key) =>
    previousDescriptions.has(stripSprintPrefix(key)),
  );

  const overlapPercentage =
    currentKeys.length === 0 ? 0 : (duplicateKeys.length / currentKeys.length) * 100;

  return {
    isDuplicate: currentKeys.length > 0 && overlapPercentage === 100,
    duplicateKeys,
    overlapPercentage,
  };
}
