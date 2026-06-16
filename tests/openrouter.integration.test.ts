import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/magi/agents";
import { OpenRouterAgentRunner } from "../src/magi/openrouter";
import type { RoundSnapshot } from "../src/magi/types";

const runIntegration = process.env.RUN_OPENROUTER_INTEGRATION === "1";

describe.skipIf(!runIntegration)("OpenRouterAgentRunner integration", () => {
  it.each(AGENTS)("gets a valid output from $model for $name", async (agent) => {
    const runner = new OpenRouterAgentRunner({ timeoutMs: 240_000, maxTokens: 900 });
    const snapshot: RoundSnapshot = {
      round: 1,
      query: "Should the MAGI MVP remain read-only?",
      language: "en",
      internet_search_enabled: false,
      shared_search_results: [
        {
          id: "initial",
          query: "Should the MAGI MVP remain read-only?",
          title: "Read-only policy",
          snippet: "The PRD states the MVP must not execute commands, modify files, or call write APIs.",
          source: "test://prd",
          requestedBy: "system",
          round: 0
        }
      ],
      discussion_history: [],
      tool_history: []
    };

    const output = await runner.run(agent, snapshot);

    expect(output.agent).toBe(agent.name);
    expect(["yes", "no"]).toContain(output.decision);
    expect(output.shared_explanation.length).toBeGreaterThan(0);
  }, 300_000);
});
