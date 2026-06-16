export type AgentName = "melchior" | "balthasar" | "casper";
export type Decision = "yes" | "no" | "error";
export type FinalResult = Decision;
export type OutputLanguage = "en" | "zh-TW" | "ja";

export interface ToolRequest {
  tool: "internet_search";
  query: string;
}

export interface SearchResult {
  id: string;
  query: string;
  title: string;
  snippet: string;
  source: string;
  requestedBy: AgentName | "system";
  round: number;
}

export interface AgentOutput {
  agent: AgentName;
  decision: Decision;
  confidence: number;
  shared_explanation: string;
  objections_to_others: Record<string, string>;
  persuasion_message: string;
  what_would_change_my_mind: string;
  tool_requests: ToolRequest[];
  tool_results?: ToolHistoryEntry[];
  raw_thinking?: string;
  parse_error?: boolean;
}

export interface ToolHistoryEntry {
  round: number;
  requestingAgent: AgentName | "system";
  request: ToolRequest;
  results: SearchResult[];
}

export interface RoundRecord {
  round: number;
  snapshot: RoundSnapshot;
  agent_outputs: AgentOutput[];
  tool_results: ToolHistoryEntry[];
}

export interface RoundSnapshot {
  round: number;
  query: string;
  language: OutputLanguage;
  internet_search_enabled: boolean;
  shared_search_results: SearchResult[];
  discussion_history: Array<{
    round: number;
    agent_outputs: Array<Omit<AgentOutput, "raw_thinking">>;
  }>;
  tool_history: ToolHistoryEntry[];
}

export interface FinalDecision {
  result: FinalResult;
  method: "consensus" | "majority_vote" | "stable_vote" | "error";
  round_count: number;
  vote_breakdown: Record<Decision, number>;
  stats: {
    mind_changes: Record<AgentName, number>;
    agent_errors: Record<AgentName, number>;
    total_mind_changes: number;
    total_errors: number;
  };
  final_summary: string;
}

export interface ThinkingLog {
  round: number;
  agent: AgentName;
  iteration: number;
  phase: "tool_request" | "final" | "repair";
  thinking: string;
}

export interface MagiState {
  id?: string;
  query: string;
  current_round: number;
  max_rounds: number;
  search_before_discuss: SearchResult[];
  shared_search_pool: SearchResult[];
  discussion_history: RoundRecord[];
  tool_history: ToolHistoryEntry[];
  user_audit_log: Array<Record<string, unknown>>;
  thinking_log?: ThinkingLog[];
  language?: OutputLanguage;
  internet_search_enabled?: boolean;
  final_decision: FinalDecision | null;
  pending_round_snapshot?: RoundSnapshot | null;
  pending_agent_outputs?: AgentOutput[];
  pending_tool_results?: ToolHistoryEntry[];
  pending_thinking_log?: ThinkingLog[];
  pending_audit_events?: Array<Record<string, unknown>>;
}

export interface MagiStreamEvent {
  type: "state" | "done" | "error";
  node?: string;
  state?: MagiState;
  error?: string;
}

export interface AgentDefinition {
  name: AgentName;
  displayName: string;
  role: string;
  focus: string[];
  priority: string[];
  model: string;
}

export interface AgentRunner {
  run(agent: AgentDefinition, snapshot: RoundSnapshot): Promise<AgentOutput>;
  runTurn?(
    agent: AgentDefinition,
    snapshot: RoundSnapshot,
    context: {
      searchAdapter: SearchAdapter;
      maxToolIterations: number;
      internetSearchEnabled: boolean;
      language: OutputLanguage;
    }
  ): Promise<{
    output: AgentOutput;
    toolResults: ToolHistoryEntry[];
    thinkingLog: ThinkingLog[];
    auditEvents: Array<Record<string, unknown>>;
  }>;
}

export interface SearchAdapter {
  search(query: string, requestedBy: AgentName | "system", round: number): Promise<SearchResult[]>;
}

export interface EngineOptions {
  query: string;
  maxRounds?: number;
  enableInternetSearch?: boolean;
  language?: OutputLanguage;
  agentRunner?: AgentRunner;
  searchAdapter?: SearchAdapter;
}

export interface EngineRunOptions extends EngineOptions {
  onUpdate?: (event: MagiStreamEvent) => void;
}
