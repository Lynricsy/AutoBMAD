import { describe, test, expect } from "bun:test";

import {
  detectDuplicateStories,
  stripSprintPrefix,
} from "../../src/core/duplicate-detector.js";

describe("stripSprintPrefix", () => {
  test("strips sprint-story prefix and preserves unmatched keys", () => {
    expect(stripSprintPrefix("1-1-auth-service")).toBe("auth-service");
    expect(stripSprintPrefix("12-34-payment-flow")).toBe("payment-flow");
    expect(stripSprintPrefix("3-2-")).toBe("");
    expect(stripSprintPrefix("epic-1")).toBe("epic-1");
    expect(stripSprintPrefix("story-without-prefix")).toBe("story-without-prefix");
  });
});

describe("detectDuplicateStories", () => {
  test("returns duplicate when overlap is 100%", () => {
    const previousKeys = ["1-1-auth-service", "1-2-user-profile", "1-3-dashboard"];
    const currentKeys = ["2-1-auth-service", "2-2-user-profile", "2-3-dashboard"];

    const result = detectDuplicateStories(previousKeys, currentKeys);

    expect(result.isDuplicate).toBe(true);
    expect(result.duplicateKeys).toEqual(currentKeys);
    expect(result.overlapPercentage).toBe(100);
  });

  test("returns non-duplicate when overlap is 0%", () => {
    const previousKeys = ["1-1-auth-service", "1-2-user-profile"];
    const currentKeys = ["2-1-payment-flow", "2-2-notifications"];

    const result = detectDuplicateStories(previousKeys, currentKeys);

    expect(result.isDuplicate).toBe(false);
    expect(result.duplicateKeys).toEqual([]);
    expect(result.overlapPercentage).toBe(0);
  });

  test("returns non-duplicate and correct percentage on partial overlap", () => {
    const previousKeys = ["1-1-auth-service", "1-2-user-profile", "1-3-dashboard"];
    const currentKeys = ["2-1-auth-service", "2-2-billing", "2-3-dashboard", "2-4-alerts"];

    const result = detectDuplicateStories(previousKeys, currentKeys);

    expect(result.isDuplicate).toBe(false);
    expect(result.duplicateKeys).toEqual(["2-1-auth-service", "2-3-dashboard"]);
    expect(result.overlapPercentage).toBe(50);
  });

  test("handles empty arrays", () => {
    const result = detectDuplicateStories([], []);

    expect(result.isDuplicate).toBe(false);
    expect(result.duplicateKeys).toEqual([]);
    expect(result.overlapPercentage).toBe(0);
  });

  test("detects single story overlap", () => {
    const result = detectDuplicateStories(["1-1-auth-service"], ["2-1-auth-service"]);

    expect(result.isDuplicate).toBe(true);
    expect(result.duplicateKeys).toEqual(["2-1-auth-service"]);
    expect(result.overlapPercentage).toBe(100);
  });

  test("detects duplicates across different sprint numbers", () => {
    const previousKeys = ["10-8-payment-flow", "10-9-risk-engine"];
    const currentKeys = ["2-3-payment-flow", "2-4-risk-engine"];

    const result = detectDuplicateStories(previousKeys, currentKeys);

    expect(result.isDuplicate).toBe(true);
    expect(result.duplicateKeys).toEqual(currentKeys);
    expect(result.overlapPercentage).toBe(100);
  });
});
