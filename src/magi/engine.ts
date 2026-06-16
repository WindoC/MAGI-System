import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { AGENTS } from "./agents";
import { deepClone, deepFreeze } from "./json";
import { OpenRouterAgentRunner } from "./openrouter";
import { InternetSearchAdapter } from "./search";
import type {
  AgentOutput,
  EngineOptions,
  EngineRunOptions,
  FinalDecision,
  FinalResult,
  MagiState,
  MagiStreamEvent,
  OutputLanguage,
  RoundRecord,
  RoundSnapshot,
  SearchResult,
  ToolHistoryEntry
} from "./types";

export const MAGI_GRAPH_NODE_NAMES = [
  "initial_search",
  "create_round_snapshot",
  "melchior",
  "balthasar",
  "casper",
  "record_round",
  "next_round",
  "finalize"
] as const;

const MagiAnnotation = Annotation.Root({
  id: Annotation<string | undefined>(),
  query: Annotation<string>(),
  current_round: Annotation<number>(),
  max_rounds: Annotation<number>(),
  search_before_discuss: Annotation<SearchResult[]>(),
  shared_search_pool: Annotation<SearchResult[]>(),
  discussion_history: Annotation<RoundRecord[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  tool_history: Annotation<ToolHistoryEntry[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  user_audit_log: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  thinking_log: Annotation<NonNullable<MagiState["thinking_log"]>>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  language: Annotation<OutputLanguage>(),
  internet_search_enabled: Annotation<boolean>(),
  final_decision: Annotation<FinalDecision | null>(),
  pending_round_snapshot: Annotation<RoundSnapshot | null>(),
  pending_agent_outputs: Annotation<AgentOutput[]>({
    reducer: (left, right) => right.length === 0 ? [] : left.concat(right),
    default: () => []
  }),
  pending_tool_results: Annotation<ToolHistoryEntry[]>({
    reducer: (left, right) => right.length === 0 ? [] : left.concat(right),
    default: () => []
  }),
  pending_thinking_log: Annotation<NonNullable<MagiState["thinking_log"]>>({
    reducer: (left, right) => right.length === 0 ? [] : left.concat(right),
    default: () => []
  }),
  pending_audit_events: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => right.length === 0 ? [] : left.concat(right),
    default: () => []
  })
});

type GraphState = typeof MagiAnnotation.State;
type GraphUpdate = Partial<GraphState>;

export class MagiEngine {
  private readonly agentRunner;
  private readonly searchAdapter;

  constructor(options: Pick<EngineOptions, "agentRunner" | "searchAdapter"> = {}) {
    this.agentRunner = options.agentRunner ?? new OpenRouterAgentRunner();
    this.searchAdapter = options.searchAdapter ?? new InternetSearchAdapter();
  }

  async run(options: EngineRunOptions): Promise<MagiState> {
    const maxRounds = options.maxRounds ?? 5;
    const language = options.language ?? "en";
    const internetSearchEnabled = options.enableInternetSearch ?? false;
    const state: GraphState = {
      id: undefined,
      query: options.query,
      current_round: 1,
      max_rounds: maxRounds,
      search_before_discuss: [],
      shared_search_pool: [],
      discussion_history: [],
      tool_history: [],
      user_audit_log: [],
      thinking_log: [],
      language,
      internet_search_enabled: internetSearchEnabled,
      final_decision: null,
      pending_round_snapshot: null,
      pending_agent_outputs: [],
      pending_tool_results: [],
      pending_thinking_log: [],
      pending_audit_events: []
    };

    const graph = buildMagiGraph(this.agentRunner, this.searchAdapter, {
      debug: isGraphDebugEnabled(),
      onUpdate: options.onUpdate
    });
    const finalState = await graph.invoke(state, { recursionLimit: maxRounds * MAGI_GRAPH_NODE_NAMES.length + 10 });
    options.onUpdate?.({ type: "done", node: "done", state: stripPendingState(finalState) });
    return stripPendingState(finalState);
  }

  async runRound(state: MagiState): Promise<RoundRecord> {
    const roundNumber = state.current_round;
    const snapshot = createSnapshot(state, roundNumber);
    const turnResults = await Promise.all(
      AGENTS.map((agent) =>
        this.agentRunner.runTurn
          ? this.agentRunner.runTurn(agent, snapshot, {
              searchAdapter: this.searchAdapter,
              maxToolIterations: state.internet_search_enabled ? getMaxToolIterations() : 0,
              internetSearchEnabled: state.internet_search_enabled ?? false,
              language: state.language ?? "en"
            })
          : this.agentRunner.run(agent, snapshot).then((output) => ({
              output,
              toolResults: [] as ToolHistoryEntry[],
              thinkingLog: [],
              auditEvents: []
            }))
      )
    );
    const outputs = sanitizeToolRequests(turnResults.map((result) => result.output), state.internet_search_enabled ?? false);
    const privateToolResults = turnResults.flatMap((result) => result.toolResults);
    const fallbackToolResults =
      this.agentRunner.runTurn || !state.internet_search_enabled ? [] : await this.executeToolRequests(roundNumber, outputs);
    const toolResults = [...privateToolResults, ...fallbackToolResults];

    for (const entry of toolResults) {
      state.shared_search_pool.push(...entry.results);
      state.tool_history.push(entry);
    }

    const record: RoundRecord = {
      round: roundNumber,
      snapshot: deepClone(snapshot),
      agent_outputs: outputs,
      tool_results: toolResults
    };

    state.current_round = roundNumber;
    state.discussion_history.push(record);
    state.thinking_log = state.thinking_log ?? [];
    state.thinking_log.push(...turnResults.flatMap((result) => result.thinkingLog));
    state.user_audit_log.push(
      ...turnResults.flatMap((result) => result.auditEvents),
      { event: "round_completed", round: roundNumber, outputs, toolResults }
    );
    return record;
  }

  async executeToolRequests(round: number, outputs: AgentOutput[]): Promise<ToolHistoryEntry[]> {
    return executeToolRequestsForOutputs(this.searchAdapter, round, outputs);
  }
}

export function buildMagiGraph(
  agentRunner: MagiEngine["agentRunner"],
  searchAdapter: MagiEngine["searchAdapter"],
  options: { debug?: boolean; onUpdate?: (event: MagiStreamEvent) => void } = {}
) {
  const initialSearch = async (state: GraphState): Promise<GraphUpdate> => {
    if (!state.internet_search_enabled) {
      return {
        search_before_discuss: [],
        shared_search_pool: [],
        tool_history: [],
        user_audit_log: [
          {
            event: "initial_search_skipped",
            reason: "internet_search_disabled"
          }
        ]
      };
    }

    const results = await searchAdapter.search(state.query, "system", 0);
    const entry: ToolHistoryEntry = {
      round: 0,
      requestingAgent: "system",
      request: { tool: "internet_search", query: state.query },
      results
    };

    return {
      search_before_discuss: results,
      shared_search_pool: results,
      tool_history: [entry],
      user_audit_log: [{ event: "initial_search", query: state.query, results }]
    };
  };

  const createRoundSnapshot = (state: GraphState): GraphUpdate => {
    return {
      pending_round_snapshot: createSnapshot(state, state.current_round),
      pending_agent_outputs: [],
      pending_tool_results: [],
      pending_thinking_log: [],
      pending_audit_events: []
    };
  };

  const runAgentNode = (agentIndex: number) => async (state: GraphState): Promise<GraphUpdate> => {
    if (!state.pending_round_snapshot) {
      throw new Error("Cannot run agents without a pending round snapshot.");
    }

    const agent = AGENTS[agentIndex];
    try {
      const turn = agentRunner.runTurn
        ? await agentRunner.runTurn(agent, state.pending_round_snapshot, {
            searchAdapter,
            maxToolIterations: state.internet_search_enabled ? getMaxToolIterations() : 0,
            internetSearchEnabled: state.internet_search_enabled,
            language: state.language
          })
        : await agentRunner.run(agent, state.pending_round_snapshot).then((output) => ({
            output,
            toolResults: [] as ToolHistoryEntry[],
            thinkingLog: [],
            auditEvents: []
          }));
      const [output] = sanitizeToolRequests([
        {
          ...turn.output,
          tool_results: turn.toolResults.length > 0 ? turn.toolResults : turn.output.tool_results
        }
      ], state.internet_search_enabled);
      const update: GraphUpdate = {
        pending_agent_outputs: [output]
      };
      if (turn.toolResults.length > 0) {
        update.pending_tool_results = turn.toolResults;
      }
      if (turn.thinkingLog.length > 0) {
        update.pending_thinking_log = turn.thinkingLog;
      }
      if (turn.auditEvents.length > 0) {
        update.pending_audit_events = turn.auditEvents;
      }
      return update;
    } catch (error) {
      console.warn("[MAGI agent] agent execution failed; using transparent fallback output", {
        agent: agent.name,
        round: state.pending_round_snapshot?.round,
        error: errorMessage(error)
      });
      const output = createAgentFailureOutput(agent, error);
      return {
        pending_agent_outputs: [output]
      };
    }
  };

  const recordRound = async (state: GraphState): Promise<GraphUpdate> => {
    if (!state.pending_round_snapshot) {
      throw new Error("Cannot record a round without a pending round snapshot.");
    }

    const fallbackToolResults =
      agentRunner.runTurn || !state.internet_search_enabled
        ? []
        : await executeToolRequestsForOutputs(searchAdapter, state.pending_round_snapshot.round, state.pending_agent_outputs);
    const outputs = attachFallbackToolResults(state.pending_agent_outputs, fallbackToolResults);
    const toolResultsFromOutputs = outputs.flatMap((output) => output.tool_results ?? []);
    const toolResults = toolResultsFromOutputs.length > 0 ? toolResultsFromOutputs : state.pending_tool_results;

    const record: RoundRecord = {
      round: state.pending_round_snapshot.round,
      snapshot: deepClone(state.pending_round_snapshot),
      agent_outputs: outputs,
      tool_results: toolResults
    };

    return {
      current_round: state.pending_round_snapshot.round,
      shared_search_pool: [
        ...state.shared_search_pool,
        ...toolResults.flatMap((entry) => entry.results)
      ],
      tool_history: toolResults,
      discussion_history: [record],
      thinking_log: state.pending_thinking_log,
      user_audit_log: [
        ...state.pending_audit_events,
        {
          event: "round_tools_persisted",
          round: state.pending_round_snapshot.round,
          tool_result_count: toolResults.length
        },
        {
          event: "round_completed",
          round: state.pending_round_snapshot.round,
          outputs,
          toolResults
        }
      ],
      pending_round_snapshot: null,
      pending_agent_outputs: [],
      pending_tool_results: [],
      pending_thinking_log: [],
      pending_audit_events: []
    };
  };

  const routeAfterRound = (state: GraphState): "next_round" | "finalize" => {
    const latestVotes = latestVotesForCurrentRound(state);
    const errorCount = latestVotes.filter((vote) => vote.decision === "error").length;
    if (errorCount >= 2) {
      return "finalize";
    }

    const consensus = getConsensus(latestVotes);

    if (consensus) {
      return "finalize";
    }

    if (hasStableDecisionsForTwoRounds(state.discussion_history)) {
      return "finalize";
    }

    if (state.current_round >= state.max_rounds) {
      return "finalize";
    }

    return "next_round";
  };

  const nextRound = (state: GraphState): GraphUpdate => {
    return {
      current_round: state.current_round + 1,
      user_audit_log: [{ event: "next_round", round: state.current_round + 1 }]
    };
  };

  const finalize = (state: GraphState): GraphUpdate => {
    const latestVotes = latestVotesForCurrentRound(state);
    const errorCount = latestVotes.filter((vote) => vote.decision === "error").length;
    const consensus = getConsensus(latestVotes);
    const stable = hasStableDecisionsForTwoRounds(state.discussion_history);
    const majority = getMajority(latestVotes);
    const result = errorCount >= 2 ? "error" : consensus ?? majority;
    const method: FinalDecision["method"] =
      errorCount >= 2
        ? "error"
        : consensus
          ? "consensus"
          : stable && majority !== "error"
            ? "stable_vote"
            : majority === "error"
              ? "error"
              : "majority_vote";
    const finalDecision = buildFinalDecision(result, method, state.current_round, latestVotes, state.discussion_history);
    return {
      final_decision: finalDecision,
      user_audit_log: [
        { event: "final_decision", ...finalDecision },
        { event: "finalized", final_decision: finalDecision, framework: "langgraph-js" }
      ]
    };
  };

  return new StateGraph(MagiAnnotation)
    .addNode("initial_search", traceNode("initial_search", initialSearch, options.debug, options.onUpdate))
    .addNode("create_round_snapshot", traceNode("create_round_snapshot", createRoundSnapshot, options.debug, options.onUpdate))
    .addNode("melchior", traceNode("melchior", runAgentNode(0), options.debug, options.onUpdate))
    .addNode("balthasar", traceNode("balthasar", runAgentNode(1), options.debug, options.onUpdate))
    .addNode("casper", traceNode("casper", runAgentNode(2), options.debug, options.onUpdate))
    .addNode("record_round", traceNode("record_round", recordRound, options.debug, options.onUpdate))
    .addNode("next_round", traceNode("next_round", nextRound, options.debug, options.onUpdate))
    .addNode("finalize", traceNode("finalize", finalize, options.debug, options.onUpdate))
    .addEdge(START, "initial_search")
    .addEdge("initial_search", "create_round_snapshot")
    .addEdge("create_round_snapshot", "melchior")
    .addEdge("create_round_snapshot", "balthasar")
    .addEdge("create_round_snapshot", "casper")
    .addEdge(["melchior", "balthasar", "casper"], "record_round")
    .addConditionalEdges("record_round", routeAfterRound, {
      next_round: "next_round",
      finalize: "finalize"
    })
    .addEdge("next_round", "create_round_snapshot")
    .addEdge("finalize", END)
    .compile({ name: "magi-deliberation" });
}

export function createSnapshot(state: MagiState, round: number): RoundSnapshot {
  return deepFreeze(
    deepClone({
      round,
      query: state.query,
      language: state.language ?? "en",
      internet_search_enabled: state.internet_search_enabled ?? false,
      shared_search_results: state.shared_search_pool,
      discussion_history: state.discussion_history.map((record) => ({
        round: record.round,
        agent_outputs: record.agent_outputs.map(({ raw_thinking: _raw, ...visible }) => visible)
      })),
      tool_history: state.tool_history
    })
  );
}

export function getConsensus(outputs: AgentOutput[]): "yes" | "no" | null {
  const activeOutputs = outputs.filter((output): output is AgentOutput & { decision: "yes" | "no" } => output.decision !== "error");
  if (activeOutputs.length < 2) {
    return null;
  }

  const first = activeOutputs[0]?.decision;
  return activeOutputs.every((output) => output.decision === first) ? first : null;
}

export function getMajority(outputs: AgentOutput[]): FinalResult {
  const yes = outputs.filter((output) => output.decision === "yes").length;
  const no = outputs.filter((output) => output.decision === "no").length;
  if (yes === no) {
    return "error";
  }
  return yes > no ? "yes" : "no";
}

function hasStableDecisionsForTwoRounds(history: RoundRecord[]): boolean {
  if (history.length < 2) {
    return false;
  }

  const latest = history.at(-1)?.agent_outputs ?? [];
  const previous = history.at(-2)?.agent_outputs ?? [];
  return AGENTS.every((agent) => {
    const latestDecision = latest.find((output) => output.agent === agent.name)?.decision;
    const previousDecision = previous.find((output) => output.agent === agent.name)?.decision;
    return latestDecision !== undefined && latestDecision === previousDecision;
  });
}

function latestVotesForCurrentRound(state: GraphState): AgentOutput[] {
  return state.discussion_history.find((record) => record.round === state.current_round)?.agent_outputs
    ?? state.discussion_history.at(-1)?.agent_outputs
    ?? [];
}

function buildFinalDecision(
  result: FinalResult,
  method: FinalDecision["method"],
  roundCount: number,
  outputs: AgentOutput[],
  history: RoundRecord[] = []
): FinalDecision {
  const vote_breakdown = {
    yes: outputs.filter((output) => output.decision === "yes").length,
    no: outputs.filter((output) => output.decision === "no").length,
    error: outputs.filter((output) => output.decision === "error").length
  };

  return {
    result,
    method,
    round_count: roundCount,
    vote_breakdown,
    stats: buildFinalStats(history.length > 0 ? history : [{ round: roundCount, snapshot: {} as RoundSnapshot, agent_outputs: outputs, tool_results: [] }]),
    final_summary: finalSummary(result, method, roundCount)
  };
}

function finalSummary(
  result: FinalResult,
  method: FinalDecision["method"],
  roundCount: number
): string {
  return `result=${result};method=${method};rounds=${roundCount}`;
}

function stripPendingState(state: GraphState): MagiState {
  const {
    pending_round_snapshot: _pendingRoundSnapshot,
    pending_agent_outputs: _pendingAgentOutputs,
    pending_tool_results: _pendingToolResults,
    pending_thinking_log: _pendingThinkingLog,
    pending_audit_events: _pendingAuditEvents,
    ...publicState
  } = state;

  return publicState;
}

function createAgentFailureOutput(agent: (typeof AGENTS)[number], error: unknown): AgentOutput {
  return {
    agent: agent.name,
    decision: "error",
    confidence: 0,
    shared_explanation:
      "This agent could not complete its model call. The system recorded ERROR so the synchronized round can finish without counting this agent as a vote.",
    objections_to_others: {},
    persuasion_message: "Treat this as an execution failure, not a substantive argument from the agent.",
    what_would_change_my_mind: "A successful local model response for this same immutable snapshot.",
    tool_requests: [],
    tool_results: [],
    raw_thinking: `Agent execution failure for ${agent.name} using ${agent.model}: ${errorMessage(error)}`
  };
}

function buildFinalStats(history: RoundRecord[]): FinalDecision["stats"] {
  const mindChanges: FinalDecision["stats"]["mind_changes"] = {
    melchior: 0,
    balthasar: 0,
    casper: 0
  };
  const agentErrors: FinalDecision["stats"]["agent_errors"] = {
    melchior: 0,
    balthasar: 0,
    casper: 0
  };
  const previousDecision: Partial<Record<AgentOutput["agent"], "yes" | "no">> = {};

  for (const round of history) {
    for (const output of round.agent_outputs) {
      if (output.decision === "error") {
        agentErrors[output.agent] += 1;
        continue;
      }

      if (previousDecision[output.agent] && previousDecision[output.agent] !== output.decision) {
        mindChanges[output.agent] += 1;
      }
      previousDecision[output.agent] = output.decision;
    }
  }
  return {
    mind_changes: mindChanges,
    agent_errors: agentErrors,
    total_mind_changes: Object.values(mindChanges).reduce((sum, count) => sum + count, 0),
    total_errors: Object.values(agentErrors).reduce((sum, count) => sum + count, 0)
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

function isGraphDebugEnabled(): boolean {
  if (process.env.MAGI_GRAPH_DEBUG === "1") {
    return true;
  }

  if (process.env.MAGI_GRAPH_DEBUG === "0") {
    return false;
  }

  return process.env.NODE_ENV === "development";
}

function traceNode(
  nodeName: string,
  handler: (state: GraphState) => GraphUpdate | Promise<GraphUpdate>,
  enabled = false,
  onUpdate?: (event: MagiStreamEvent) => void
) {
  return async (state: GraphState): Promise<GraphUpdate> => {
    if (!enabled) {
      const update = await handler(state);
      onUpdate?.({
        type: "state",
        node: nodeName,
        state: mergeStateForStream(state, update)
      });
      return update;
    }

    const startedAt = performance.now();
    console.info(`[MAGI LangGraph] node:start ${nodeName}`, summarizeState(state));

    try {
      const update = await handler(state);
      onUpdate?.({
        type: "state",
        node: nodeName,
        state: mergeStateForStream(state, update)
      });
      console.info(`[MAGI LangGraph] node:end ${nodeName}`, {
        durationMs: Math.round(performance.now() - startedAt),
        update: summarizeUpdate(update)
      });
      return update;
    } catch (error) {
      console.error(`[MAGI LangGraph] node:error ${nodeName}`, {
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };
}

function summarizeState(state: GraphState) {
  return {
    round: state.current_round,
    maxRounds: state.max_rounds,
    searchResults: state.shared_search_pool.length,
    historyRounds: state.discussion_history.length,
    pendingSnapshotRound: state.pending_round_snapshot?.round ?? null,
    pendingOutputs: state.pending_agent_outputs.length,
    pendingToolResults: state.pending_tool_results.length,
    finalDecision: state.final_decision?.result ?? null
  };
}

function summarizeUpdate(update: GraphUpdate) {
  return {
    current_round: update.current_round,
    search_before_discuss: update.search_before_discuss?.length,
    shared_search_pool: update.shared_search_pool?.length,
    discussion_history: update.discussion_history?.length,
    tool_history: update.tool_history?.length,
    pending_round_snapshot: update.pending_round_snapshot?.round ?? update.pending_round_snapshot,
    pending_agent_outputs: update.pending_agent_outputs?.map((output) => `${output.agent}:${output.decision}`),
    pending_tool_results: update.pending_tool_results?.length,
    pending_thinking_log: update.pending_thinking_log?.length,
    final_decision: update.final_decision
      ? { result: update.final_decision.result, method: update.final_decision.method }
      : update.final_decision
  };
}

function mergeStateForStream(state: GraphState, update: GraphUpdate): MagiState {
  const merged = { ...state, ...update };

  if (update.discussion_history) {
    merged.discussion_history = state.discussion_history.concat(update.discussion_history);
  }
  if (update.tool_history) {
    merged.tool_history = state.tool_history.concat(update.tool_history);
  }
  if (update.user_audit_log) {
    merged.user_audit_log = state.user_audit_log.concat(update.user_audit_log);
  }
  if (update.thinking_log) {
    merged.thinking_log = state.thinking_log.concat(update.thinking_log);
  }

  if (update.pending_agent_outputs) {
    merged.pending_agent_outputs = update.pending_agent_outputs.length === 0
      ? []
      : state.pending_agent_outputs.concat(update.pending_agent_outputs);
  }
  if (update.pending_tool_results) {
    merged.pending_tool_results = update.pending_tool_results.length === 0
      ? []
      : state.pending_tool_results.concat(update.pending_tool_results);
  }
  if (update.pending_thinking_log) {
    merged.pending_thinking_log = update.pending_thinking_log.length === 0
      ? []
      : state.pending_thinking_log.concat(update.pending_thinking_log);
  }
  if (update.pending_audit_events) {
    merged.pending_audit_events = update.pending_audit_events.length === 0
      ? []
      : state.pending_audit_events.concat(update.pending_audit_events);
  }

  return merged;
}

function getMaxToolIterations(): number {
  const configured = Number(process.env.MAGI_MAX_TOOL_ITERATIONS ?? 2);
  return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 2;
}

function sanitizeToolRequests(outputs: AgentOutput[], internetSearchEnabled: boolean): AgentOutput[] {
  if (internetSearchEnabled) {
    return outputs;
  }

  return outputs.map((output) => ({
    ...output,
    tool_requests: [],
    tool_results: []
  }));
}

async function executeToolRequestsForOutputs(
  searchAdapter: MagiEngine["searchAdapter"],
  round: number,
  outputs: AgentOutput[]
): Promise<ToolHistoryEntry[]> {
  const entries: ToolHistoryEntry[] = [];
  if (outputs.length === 0) {
    return entries;
  }

  for (const output of outputs) {
    for (const request of output.tool_requests) {
      const results = await searchAdapter.search(request.query, output.agent, round);
      entries.push({
        round,
        requestingAgent: output.agent,
        request,
        results
      });
    }
  }

  return entries;
}

function attachFallbackToolResults(outputs: AgentOutput[], fallbackToolResults: ToolHistoryEntry[]): AgentOutput[] {
  if (fallbackToolResults.length === 0) {
    return outputs;
  }

  return outputs.map((output) => {
    const resultsForAgent = fallbackToolResults.filter((entry) => entry.requestingAgent === output.agent);
    if (resultsForAgent.length === 0) {
      return output;
    }

    return {
      ...output,
      tool_results: [...(output.tool_results ?? []), ...resultsForAgent]
    };
  });
}
