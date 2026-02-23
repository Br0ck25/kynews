import { describe, expect, it } from "vitest";
import { isKentuckyRelevant } from "../src/services/relevance";

describe("isKentuckyRelevant", () => {
  it("passes Tier 1 when title has strong Kentucky signal", () => {
    const result = isKentuckyRelevant("Kentucky lawmakers debate school funding", "");
    expect(result.relevant).toBe(true);
    expect(result.matchedTier).toBe("tier1_title");
  });

  it("fails Tier 3 for ambiguous city without Kentucky context", () => {
    const result = isKentuckyRelevant("Lexington city council vote", "Council members met Tuesday.");
    expect(result.relevant).toBe(false);
    expect(result.failedTier).toBe("tier3_ambiguous_city");
  });

  it("passes Tier 2 with at least two Kentucky-related body mentions", () => {
    const result = isKentuckyRelevant("Regional update", "Frankfort officials joined Kentucky emergency teams.");
    expect(result.relevant).toBe(true);
    expect(result.matchedTier).toBe("tier2_body");
  });

  it("fails Tier 2 with only one body mention", () => {
    const result = isKentuckyRelevant("Regional update", "Officials in Frankfort met Tuesday.");
    expect(result.relevant).toBe(false);
    expect(result.failedTier).toBe("tier2_body");
  });
});
