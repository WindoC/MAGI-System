import { afterEach, describe, expect, it, vi } from "vitest";
import { MAGI_GRAPH_NODE_NAMES, MagiEngine, createSnapshot } from "../src/magi/engine";
import type { AgentDefinition, AgentOutput, AgentRunner, MagiState, RoundSnapshot, SearchAdapter, SearchResult } from "../src/magi/types";

function output(agent: AgentDefinition, decision: "yes" | "no" | "error", toolQuery?: string): AgentOutput {
  return {
    agent: agent.name,
    decision,
    confidence: 0.8,
    shared_explanation: `${agent.name} explanation`,
    objections_to_others: {},
    persuasion_message: `${agent.name} persuasion`,
    what_would_change_my_mind: "better evidence",
    tool_requests: toolQuery ? [{ tool: "internet_search", query: toolQuery }] : [],
    raw_thinking: `${agent.name} private thinking`
  };
}

class SequenceRunner implements AgentRunner {
  public snapshots: RoundSnapshot[] = [];

  constructor(private readonly rounds: Array<Record<string, "yes" | "no">>) {}

  async run(agent: AgentDefinition, snapshot: RoundSnapshot): Promise<AgentOutput> {
    this.snapshots.push(snapshot);
    const decision = this.rounds[snapshot.round - 1]?.[agent.name] ?? "yes";
    const toolQuery = snapshot.round === 1 && agent.name === "casper" ? "edge case evidence" : undefined;
    return output(agent, decision, toolQuery);
  }
}

class OneAgentFailsRunner extends SequenceRunner {
  async run(agent: AgentDefinition, snapshot: RoundSnapshot): Promise<AgentOutput> {
    if (agent.name === "balthasar") {
      throw new Error("model timeout");
    }

    return super.run(agent, snapshot);
  }
}

class TwoAgentsFailRunner extends SequenceRunner {
  async run(agent: AgentDefinition, snapshot: RoundSnapshot): Promise<AgentOutput> {
    if (agent.name === "balthasar" || agent.name === "casper") {
      throw new Error(`${agent.name} timeout`);
    }

    return super.run(agent, snapshot);
  }
}

class PrivateToolTurnRunner implements AgentRunner {
  public snapshots: RoundSnapshot[] = [];

  async run(agent: AgentDefinition, snapshot: RoundSnapshot): Promise<AgentOutput> {
    throw new Error(`run should not be used when runTurn is available for ${agent.name}`);
  }

  async runTurn(
    agent: AgentDefinition,
    snapshot: RoundSnapshot,
    context: { searchAdapter: SearchAdapter; maxToolIterations: number }
  ) {
    this.snapshots.push(snapshot);
    const toolResults =
      snapshot.round === 1 && agent.name === "casper" && context.maxToolIterations > 0
        ? [
            {
              round: snapshot.round,
              requestingAgent: agent.name,
              request: { tool: "internet_search" as const, query: "private same round evidence" },
              results: await context.searchAdapter.search("private same round evidence", agent.name, snapshot.round)
            }
          ]
        : [];

    const decision = snapshot.round === 1 && agent.name === "balthasar" ? "no" : "yes";
    return {
      output: {
        ...output(agent, decision),
        tool_requests: toolResults.map((entry) => entry.request),
        tool_results: toolResults,
        shared_explanation:
          toolResults.length > 0 ? "Casper used private same-round evidence before finalizing." : `${agent.name} explanation`
      },
      toolResults,
      thinkingLog: [
        {
          round: snapshot.round,
          agent: agent.name,
          iteration: 1,
          phase: toolResults.length > 0 ? ("tool_request" as const) : ("final" as const),
          thinking: `${agent.name} thinking`
        }
      ],
      auditEvents: toolResults.map((entry) => ({
        event: "agent_used_tool_same_round",
        round: entry.round,
        agent: agent.name,
        query: entry.request.query
      }))
    };
  }
}

class RecordingSearch implements SearchAdapter {
  public calls: Array<{ query: string; requestedBy: string; round: number }> = [];

  async search(query: string, requestedBy: SearchResult["requestedBy"], round: number): Promise<SearchResult[]> {
    this.calls.push({ query, requestedBy, round });
    return [
      {
        id: `${round}-${requestedBy}-${query}`,
        query,
        title: `Result for ${query}`,
        snippet: "A read-only result",
        source: "test://search",
        requestedBy,
        round
      }
    ];
  }
}

describe("MagiEngine", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("declares the LangGraph lifecycle nodes used by the MVP", () => {
    expect(MAGI_GRAPH_NODE_NAMES).toEqual([
      "initial_search",
      "create_round_snapshot",
      "melchior",
      "balthasar",
      "casper",
      "record_round",
      "next_round",
      "finalize"
    ]);
  });

  it("terminates immediately when all agents reach consensus", async () => {
    const runner = new SequenceRunner([{ melchior: "yes", balthasar: "yes", casper: "yes" }]);
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: new RecordingSearch() });

    const state = await engine.run({ query: "approve design?", maxRounds: 5 });

    expect(state.final_decision).toMatchObject({ result: "yes", method: "consensus", round_count: 1 });
    expect(state.discussion_history).toHaveLength(1);
    expect(state.user_audit_log.at(-1)).toMatchObject({ event: "finalized", framework: "langgraph-js" });
  });

  it("prints LangGraph node trace logs when MAGI_GRAPH_DEBUG is enabled", async () => {
    vi.stubEnv("MAGI_GRAPH_DEBUG", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const runner = new SequenceRunner([{ melchior: "yes", balthasar: "yes", casper: "yes" }]);
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: new RecordingSearch() });

    await engine.run({ query: "debug graph?", maxRounds: 1 });

    expect(info).toHaveBeenCalledWith(expect.stringContaining("[MAGI LangGraph] node:start initial_search"), expect.anything());
    expect(info).toHaveBeenCalledWith(expect.stringContaining("[MAGI LangGraph] node:end finalize"), expect.anything());
  });

  it("uses majority vote at max rounds when consensus is not reached", async () => {
    const runner = new SequenceRunner([
      { melchior: "yes", balthasar: "no", casper: "yes" },
      { melchior: "no", balthasar: "yes", casper: "yes" }
    ]);
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: new RecordingSearch() });

    const state = await engine.run({ query: "approve design?", maxRounds: 2 });

    expect(state.final_decision).toMatchObject({ result: "yes", method: "majority_vote", round_count: 2 });
    expect(state.final_decision?.vote_breakdown).toEqual({ yes: 2, no: 1, error: 0 });
  });

  it("uses stable vote when all agent decisions are unchanged for two rounds", async () => {
    const runner = new SequenceRunner([
      { melchior: "yes", balthasar: "no", casper: "yes" },
      { melchior: "yes", balthasar: "no", casper: "yes" },
      { melchior: "no", balthasar: "no", casper: "yes" }
    ]);
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: new RecordingSearch() });

    const state = await engine.run({ query: "approve design?", maxRounds: 5 });

    expect(state.final_decision).toMatchObject({ result: "yes", method: "stable_vote", round_count: 2 });
    expect(state.discussion_history).toHaveLength(2);
    expect(state.final_decision?.final_summary).toBe("result=yes;method=stable_vote;rounds=2");
  });

  it("disables initial and agent internet search by default", async () => {
    const runner = new SequenceRunner([
      { melchior: "yes", balthasar: "no", casper: "yes" },
      { melchior: "yes", balthasar: "yes", casper: "yes" }
    ]);
    const search = new RecordingSearch();
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: search });

    const state = await engine.run({ query: "approve design?", maxRounds: 2 });

    expect(search.calls).toHaveLength(0);
    expect(state.search_before_discuss).toHaveLength(0);
    expect(state.tool_history).toHaveLength(0);
    expect(state.internet_search_enabled).toBe(false);
    expect(state.user_audit_log).toContainEqual({
      event: "initial_search_skipped",
      reason: "internet_search_disabled"
    });
  });

  it("keeps the graph running when one agent model call fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = new OneAgentFailsRunner([{ melchior: "yes", balthasar: "yes", casper: "yes" }]);
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: new RecordingSearch() });

    const state = await engine.run({ query: "handle timeout?", maxRounds: 1 });
    const failedOutput = state.discussion_history[0].agent_outputs.find((entry) => entry.agent === "balthasar");

    expect(state.final_decision).toMatchObject({ method: "consensus", result: "yes" });
    expect(failedOutput).toMatchObject({
      decision: "error",
      confidence: 0
    });
    expect(failedOutput?.raw_thinking).toContain("model timeout");
    expect(warn).toHaveBeenCalledWith(
      "[MAGI agent] agent execution failed; using transparent fallback output",
      expect.objectContaining({ agent: "balthasar", error: "model timeout" })
    );
  });

  it("ends as ERROR when two agents fail in the same round", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = new TwoAgentsFailRunner([{ melchior: "yes", balthasar: "yes", casper: "yes" }]);
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: new RecordingSearch() });

    const state = await engine.run({ query: "handle repeated timeout?", maxRounds: 5 });

    expect(state.final_decision).toMatchObject({ method: "error", result: "error", round_count: 1 });
    expect(state.final_decision?.vote_breakdown).toEqual({ yes: 1, no: 0, error: 2 });
    expect(state.final_decision?.stats.total_errors).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps current-round tool results out of same-round snapshots and persists them into later snapshots", async () => {
    const runner = new SequenceRunner([
      { melchior: "yes", balthasar: "no", casper: "yes" },
      { melchior: "yes", balthasar: "yes", casper: "yes" }
    ]);
    const search = new RecordingSearch();
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: search });

    const state = await engine.run({ query: "approve design?", maxRounds: 2, enableInternetSearch: true });
    const roundOneSnapshots = runner.snapshots.filter((snapshot) => snapshot.round === 1);
    const roundTwoSnapshots = runner.snapshots.filter((snapshot) => snapshot.round === 2);

    expect(roundOneSnapshots).toHaveLength(3);
    expect(roundOneSnapshots.every((snapshot) => snapshot.shared_search_results.every((result) => result.round === 0))).toBe(true);
    expect(roundTwoSnapshots.every((snapshot) => snapshot.shared_search_results.some((result) => result.query === "edge case evidence"))).toBe(true);
    expect(state.shared_search_pool.some((result) => result.query === "edge case evidence")).toBe(true);
    expect(state.discussion_history[0].agent_outputs.find((entry) => entry.agent === "casper")?.tool_results?.[0]?.request.query).toBe(
      "edge case evidence"
    );
  });

  it("lets an agent use private same-round search before finalizing without exposing it to peers", async () => {
    const runner = new PrivateToolTurnRunner();
    const search = new RecordingSearch();
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: search });

    const state = await engine.run({ query: "approve design?", maxRounds: 2, enableInternetSearch: true });
    const roundOneSnapshots = runner.snapshots.filter((snapshot) => snapshot.round === 1);
    const roundTwoSnapshots = runner.snapshots.filter((snapshot) => snapshot.round === 2);

    expect(search.calls.filter((call) => call.query === "private same round evidence")).toHaveLength(1);
    expect(roundOneSnapshots).toHaveLength(3);
    expect(roundOneSnapshots.every((snapshot) => !JSON.stringify(snapshot).includes("private same round evidence"))).toBe(true);
    expect(roundTwoSnapshots.every((snapshot) => snapshot.shared_search_results.some((result) => result.query === "private same round evidence"))).toBe(true);
    expect(state.discussion_history[0].agent_outputs.find((entry) => entry.agent === "casper")?.shared_explanation).toContain(
      "private same-round evidence"
    );
    expect(state.thinking_log?.some((entry) => entry.phase === "tool_request" && entry.agent === "casper")).toBe(true);
  });

  it("removes raw thinking from future discussion snapshots", async () => {
    const runner = new SequenceRunner([
      { melchior: "yes", balthasar: "no", casper: "yes" },
      { melchior: "yes", balthasar: "yes", casper: "yes" }
    ]);
    const engine = new MagiEngine({ agentRunner: runner, searchAdapter: new RecordingSearch() });

    await engine.run({ query: "approve design?", maxRounds: 2, enableInternetSearch: true });
    const roundTwoSnapshot = runner.snapshots.find((snapshot) => snapshot.round === 2);

    expect(JSON.stringify(roundTwoSnapshot?.discussion_history)).not.toContain("private thinking");
  });

  it("creates immutable snapshots from mutable state", () => {
    const state: MagiState = {
      query: "test",
      current_round: 0,
      max_rounds: 1,
      search_before_discuss: [],
      shared_search_pool: [],
      discussion_history: [],
      tool_history: [],
      user_audit_log: [],
      final_decision: null
    };

    const snapshot = createSnapshot(state, 1);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.shared_search_results)).toBe(true);
  });
});
