import { describe, expect, it } from "vitest";
import { extractJsonObject, splitRawThinking } from "../src/magi/json";

describe("json helpers", () => {
  it("extracts JSON from fenced model output", () => {
    expect(extractJsonObject("```json\n{\"decision\":\"yes\"}\n```")).toEqual({ decision: "yes" });
  });

  it("repairs common malformed JSON from local models", () => {
    expect(extractJsonObject("{agent:\"casper\",decision:\"no\",confidence:0.7}")).toEqual({
      agent: "casper",
      decision: "no",
      confidence: 0.7
    });
  });

  it("splits raw thinking from visible output", () => {
    const result = splitRawThinking("<think>private notes</think>{\"decision\":\"yes\"}");

    expect(result.rawThinking).toBe("private notes");
    expect(result.visibleText).toBe("{\"decision\":\"yes\"}");
  });
});
