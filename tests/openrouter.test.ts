import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../src/magi/agents";
import { OpenRouterAgentRunner, buildAgentPrompt, parseAgentOutput } from "../src/magi/openrouter";
import type { RoundSnapshot, SearchAdapter, SearchResult } from "../src/magi/types";

const snapshot: RoundSnapshot = {
  round: 1,
  query: "Should this pass?",
  language: "en",
  internet_search_enabled: false,
  shared_search_results: [],
  discussion_history: [],
  tool_history: []
};

describe("OpenRouterAgentRunner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("records malformed model output as ERROR instead of a NO vote", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "JSON response not valid"
              }
            }
          ]
        })
      }))
    );

    const runner = new OpenRouterAgentRunner({ apiKey: "test-key" });
    const output = await runner.run(AGENTS[0], snapshot);

    expect(output).toMatchObject({
      agent: "melchior",
      decision: "error",
      confidence: 0,
      parse_error: true
    });
    expect(output.raw_thinking).toContain("JSON response not valid");
  });

  it("rejects structurally invalid agent JSON", () => {
    expect(() =>
      parseAgentOutput(
        AGENTS[0],
        JSON.stringify({
          agent: "melchior",
          decision: "maybe",
          confidence: 1.2,
          shared_explanation: "   ",
          tool_requests: []
        })
      )
    ).toThrow();
  });

  it("includes the required JSON schema in the agent prompt", () => {
    const prompt = buildAgentPrompt(AGENTS[0], snapshot);

    expect(prompt).toContain("Required JSON Schema");
    expect(prompt).toContain('"required"');
    expect(prompt).toContain('"decision"');
    expect(prompt).toContain('"enum"');
    expect(prompt).toContain('"yes"');
    expect(prompt).toContain('"no"');
  });

  it("carries the Python MAGI SystemMessage deliberation rules", () => {
    const prompt = buildAgentPrompt(AGENTS[0], snapshot);

    expect(prompt).toContain("one of three MAGI deliberation agents");
    expect(prompt).toContain("You must strictly act as melchior");
    expect(prompt).toContain("Challenge prior arguments");
    expect(prompt).toContain("be willing to change your decision if their evidence is stronger");
    expect(prompt).toContain("Evaluate this immutable MAGI round snapshot");
    expect(prompt).toContain("Provide a discussion-visible explanation");
    expect(prompt).toContain("If internet_search is disabled, do not request tools");
  });

  it("uses LangGraph ToolNode to execute multiple tool calls before the final model response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tool-1",
                    type: "function",
                    function: {
                      name: "internet_search",
                      arguments: JSON.stringify({ query: "first query" })
                    }
                  },
                  {
                    id: "tool-2",
                    type: "function",
                    function: {
                      name: "internet_search",
                      arguments: JSON.stringify({ query: "second query" })
                    }
                  }
                ]
              }
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  agent: "melchior",
                  decision: "yes",
                  confidence: 0.8,
                  shared_explanation: "Search results support approval.",
                  objections_to_others: {},
                  persuasion_message: "The evidence is enough.",
                  what_would_change_my_mind: "Contradictory evidence.",
                  tool_requests: []
                })
              }
            }
          ]
        })
      });
    vi.stubGlobal("fetch", fetchMock);
    const searchCalls: string[] = [];
    const searchAdapter: SearchAdapter = {
      async search(query: string, requestedBy: SearchResult["requestedBy"], round: number) {
        searchCalls.push(query);
        return [
          {
            id: `${round}-${query}`,
            query,
            title: `Result ${query}`,
            snippet: "snippet",
            source: "test://search",
            requestedBy,
            round
          }
        ];
      }
    };
    const runner = new OpenRouterAgentRunner({ apiKey: "test-key" });

    const result = await runner.runTurn!(AGENTS[0], snapshot, {
      searchAdapter,
      maxToolIterations: 2,
      internetSearchEnabled: true,
      language: "en"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(searchCalls).toEqual(["first query", "second query"]);
    expect(result.output.decision).toBe("yes");
    expect(result.output.tool_requests.map((request) => request.query)).toEqual(["first query", "second query"]);
    expect(result.output.tool_results).toHaveLength(2);
    expect(result.thinkingLog.some((entry) => entry.phase === "tool_request")).toBe(true);
  });

  it("does not call tools when the model returns a final answer without tool calls", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                agent: "melchior",
                decision: "no",
                confidence: 0.7,
                shared_explanation: "No search is needed for this answer.",
                objections_to_others: {},
                persuasion_message: "The snapshot is sufficient.",
                what_would_change_my_mind: "New external evidence.",
                tool_requests: []
              })
            }
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    const searchAdapter: SearchAdapter = {
      search: vi.fn()
    };
    const runner = new OpenRouterAgentRunner({ apiKey: "test-key" });

    const result = await runner.runTurn!(AGENTS[0], snapshot, {
      searchAdapter,
      maxToolIterations: 2,
      internetSearchEnabled: true,
      language: "en"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(searchAdapter.search).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ decision: "no", tool_requests: [], tool_results: [] });
    expect(result.thinkingLog.some((entry) => entry.phase === "tool_request")).toBe(false);
  });
});
