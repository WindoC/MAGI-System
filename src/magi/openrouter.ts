import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { AGENTS } from "./agents";
import { extractJsonObject, splitRawThinking } from "./json";
import type {
  AgentDefinition,
  AgentOutput,
  AgentRunner,
  OutputLanguage,
  RoundSnapshot,
  SearchAdapter,
  ThinkingLog,
  ToolHistoryEntry,
  ToolRequest
} from "./types";
import { agentOutputSchema } from "./validation";

export interface OpenRouterRunnerOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  repairMaxTokens?: number;
  reasoning?: boolean;
}

type OpenRouterMessage = {
  role?: string;
  content?: string | null;
  reasoning?: string;
  reasoning_content?: string;
  thinking?: string;
  reasoning_details?: Array<Record<string, unknown>>;
  tool_calls?: OpenRouterRawToolCall[];
};

type OpenRouterChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenRouterRawToolCall[];
  tool_call_id?: string;
  name?: string;
};

const AgentTurnAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  iteration: Annotation<number>(),
  max_tool_iterations: Annotation<number>(),
  last_answer: Annotation<string>(),
  last_thinking: Annotation<string>(),
  raw_thinking: Annotation<string>(),
  thinking_log: Annotation<ThinkingLog[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
});

type AgentTurnGraphState = typeof AgentTurnAnnotation.State;

type OpenRouterRawToolCall = {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
};

type ParsedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type ChatResult = {
  content: string;
  thinking: string;
  toolCalls: ParsedToolCall[];
  rawMessage: OpenRouterMessage;
};

const internetSearchToolDefinition = (() => {
  const queryDescription = "Internet search query.";
  return {
    name: "internet_search",
    description: "Search for public internet information relevant to the MAGI discussion.",
    queryDescription,
    schema: z.object({
      query: z.string().describe(queryDescription)
    })
  } as const;
})();

export class OpenRouterAgentRunner implements AgentRunner {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly repairMaxTokens: number;
  private readonly reasoning: boolean;

  constructor(options: OpenRouterRunnerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    this.baseUrl = options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    this.timeoutMs = options.timeoutMs ?? Number(process.env.OPENROUTER_TIMEOUT_MS ?? 240_000);
    this.maxTokens = options.maxTokens ?? Number(process.env.MAGI_NUM_PREDICT ?? 1800);
    this.repairMaxTokens = options.repairMaxTokens ?? Number(process.env.MAGI_REPAIR_NUM_PREDICT ?? 1200);
    this.reasoning = options.reasoning ?? envBool("OPENROUTER_REASONING", true);
  }

  async run(agent: AgentDefinition, snapshot: RoundSnapshot): Promise<AgentOutput> {
    const text = await this.generateText(agent, buildAgentBaseMessages(agent, snapshot), { reasoning: this.reasoning });
    return this.parseOrRepair(agent, text);
  }

  async runTurn(
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
  }> {
    const maxToolIterations = Math.max(0, context.maxToolIterations);
    const messages = buildAgentBaseMessages(agent, snapshot, {
        internetSearchEnabled: context.internetSearchEnabled,
        language: context.language
      });
    const turnGraph = this.buildAgentTurnGraph(agent, snapshot, context);
    const turnState = await turnGraph.invoke(
      {
        messages,
        iteration: 0,
        max_tool_iterations: context.internetSearchEnabled ? maxToolIterations : 0,
        last_answer: "",
        last_thinking: "",
        raw_thinking: "",
        thinking_log: []
      },
      { recursionLimit: Math.max(4, maxToolIterations * 2 + 4) }
    );
    const toolResults = extractToolResults(turnState.messages);
    const toolRequests = extractToolRequests(turnState.messages);
    const output = await this.parseOrRepair(agent, turnState.last_answer || buildPrivateToolContext(toolResults));
    const thinkingLog = [
      ...turnState.thinking_log,
      {
        round: snapshot.round,
        agent: agent.name,
        iteration: turnState.iteration,
        phase: "final" as const,
        thinking: turnState.last_thinking || ""
      }
    ];
    const auditEvents = toolResults.map((entry, index) => ({
      event: "agent_used_tool_same_round",
      round: entry.round,
      agent: agent.name,
      iteration: toolRequests[index]?.iteration ?? 0,
      tool: entry.request.tool,
      query: entry.request.query,
      result_count: entry.results.length
    }));

    return {
      output: {
        ...output,
        tool_requests: context.internetSearchEnabled ? toolRequests.map(({ iteration: _iteration, ...request }) => request) : [],
        tool_results: toolResults,
        raw_thinking: turnState.raw_thinking || output.raw_thinking
      },
      toolResults,
      thinkingLog,
      auditEvents
    };
  }

  private buildAgentTurnGraph(
    agent: AgentDefinition,
    snapshot: RoundSnapshot,
    context: {
      searchAdapter: SearchAdapter;
      maxToolIterations: number;
      internetSearchEnabled: boolean;
      language: OutputLanguage;
    }
  ) {
    const searchTool = createInternetSearchTool(agent, snapshot, context.searchAdapter);
    const toolNode = new ToolNode([searchTool]);
    const agentNode = async (state: AgentTurnGraphState) => {
      const iteration = state.iteration + 1;
      const response = await this.chat(agent, baseMessagesToOpenRouter(state.messages), {
        reasoning: this.reasoning,
        tools: context.internetSearchEnabled
      });
      const aiMessage = new AIMessage({
        content: response.content,
        tool_calls: response.toolCalls.map((toolCall) => ({
          name: toolCall.name,
          args: toolCall.args,
          id: toolCall.id,
          type: "tool_call" as const
        })),
        additional_kwargs: {
          raw_openrouter_message: response.rawMessage,
          reasoning: response.thinking
        }
      });
      const thinkingUpdate = response.toolCalls.length > 0 && iteration <= state.max_tool_iterations
        ? [{
            round: snapshot.round,
            agent: agent.name,
            iteration,
            phase: "tool_request" as const,
            thinking: response.thinking || ""
          }]
        : [];

      return {
        messages: [aiMessage],
        iteration,
        last_answer: joinThinkingAndContent(response.thinking, response.content),
        last_thinking: response.thinking || "",
        raw_thinking: [state.raw_thinking, response.thinking].filter(Boolean).join("\n\n"),
        thinking_log: thinkingUpdate
      };
    };
    const routeAgentTurn = (state: AgentTurnGraphState): "tools" | "finalize_agent" => {
      const lastMessage = state.messages.at(-1);
      const toolCalls = AIMessage.isInstance(lastMessage) ? lastMessage.tool_calls ?? [] : [];
      return toolCalls.length > 0 && state.iteration <= state.max_tool_iterations ? "tools" : "finalize_agent";
    };

    return new StateGraph(AgentTurnAnnotation)
      .addNode("agent", agentNode)
      .addNode("tools", toolNode)
      .addNode("finalize_agent", () => ({}))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", routeAgentTurn, {
        tools: "tools",
        finalize_agent: "finalize_agent"
      })
      .addEdge("tools", "agent")
      .addEdge("finalize_agent", END)
      .compile({ name: `${agent.name}-turn` });
  }

  private async generateText(
    agent: AgentDefinition,
    messages: BaseMessage[],
    options: { reasoning: boolean; repair?: boolean }
  ): Promise<string> {
    const result = await this.chat(agent, baseMessagesToOpenRouter(messages), options);
    return joinThinkingAndContent(result.thinking, result.content);
  }

  private async chat(
    agent: AgentDefinition,
    messages: OpenRouterChatMessage[],
    options: { reasoning: boolean; repair?: boolean; tools?: boolean }
  ): Promise<ChatResult> {
    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const settings = agentSettings(agent);

    try {
      const requestPayload = {
        model: agent.model,
        messages,
        max_tokens: options.repair ? this.repairMaxTokens : this.maxTokens,
        temperature: options.repair ? 0 : settings.temperature,
        top_p: options.repair ? 0.1 : settings.topP,
        ...(options.repair ? { response_format: { type: "json_object" } } : {}),
        ...(options.tools ? { tools: openRouterToolSchema(), tool_choice: "auto", parallel_tool_calls: true } : {}),
        reasoning: options.reasoning ? { enabled: true } : { exclude: true },
        include_reasoning: options.reasoning
      };

      if (isLlmDebugEnabled()) {
        console.info(
          `[MAGI LLM] OpenRouter request\n${JSON.stringify(
            {
              agent: agent.name,
              repair: Boolean(options.repair),
              payload: requestPayload
            },
            null,
            2
          )}`
        );
      }

      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
          "X-Title": process.env.OPENROUTER_APP_NAME ?? "MAGI-System"
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`OpenRouter ${agent.model} failed with HTTP ${response.status}: ${await response.text()}`);
      }

      const responsePayload = (await response.json()) as { choices?: Array<{ message?: OpenRouterMessage }> };
      if (isLlmDebugEnabled()) {
        console.info(
          `[MAGI LLM] OpenRouter response\n${JSON.stringify(
            {
              agent: agent.name,
              repair: Boolean(options.repair),
              model: agent.model,
              payload: responsePayload
            },
            null,
            2
          )}`
        );
      }
      const message = responsePayload.choices?.[0]?.message;
      if (!message) {
        throw new Error(`OpenRouter ${agent.model} returned no message.`);
      }

      return {
        content: message.content ?? "",
        thinking: extractThinking(message),
        toolCalls: parseToolCalls(message.tool_calls ?? []),
        rawMessage: message
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseOrRepair(agent: AgentDefinition, text: string): Promise<AgentOutput> {
    try {
      return parseAgentOutput(agent, text);
    } catch (error) {
      return createInvalidModelOutput(agent, error, text);
    }
  }
}

export function parseAgentOutput(agent: AgentDefinition, text: string): AgentOutput {
  const { rawThinking, visibleText } = splitRawThinking(text);
  const parsed = agentOutputSchema.parse(extractJsonObject(visibleText || text));

  return {
    ...parsed,
    agent: agent.name,
    raw_thinking: rawThinking
  };
}

function createInvalidModelOutput(agent: AgentDefinition, error: unknown, rawOutput: string): AgentOutput {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    agent: agent.name,
    decision: "error",
    confidence: 0,
    shared_explanation:
      "The model response did not match the required MAGI discussion JSON schema. This round output is recorded as ERROR and is not counted as a YES/NO vote.",
    objections_to_others: {},
    persuasion_message: "Treat this as a model-format failure, not a substantive argument.",
    what_would_change_my_mind: "A valid JSON response with decision, confidence, and non-empty shared_explanation fields.",
    tool_requests: [],
    raw_thinking: `Invalid model output for ${agent.name}: ${reason}\n\nRaw output:\n${rawOutput}`,
    parse_error: true
  };
}

export function buildAgentPrompt(
  agent: AgentDefinition,
  snapshot: RoundSnapshot,
  options: {
    privateToolContext?: string;
    internetSearchEnabled?: boolean;
    language?: OutputLanguage;
  } = {}
): string {
  const otherAgents = AGENTS.filter((item) => item.name !== agent.name).map((item) => item.name);
  const privateToolContext = options.privateToolContext ?? "";
  const language = options.language ?? snapshot.language ?? "en";
  const internetSearchEnabled = options.internetSearchEnabled ?? snapshot.internet_search_enabled;

  return `${buildAgentSystemPrompt(agent, { internetSearchEnabled, language })}

${buildAgentUserPrompt(agent, snapshot, { privateToolContext, internetSearchEnabled })}`;
}

function buildAgentMessages(
  agent: AgentDefinition,
  snapshot: RoundSnapshot,
  options: {
    privateToolContext?: string;
    internetSearchEnabled?: boolean;
    language?: OutputLanguage;
  } = {}
): OpenRouterChatMessage[] {
  const language = options.language ?? snapshot.language ?? "en";
  const internetSearchEnabled = options.internetSearchEnabled ?? snapshot.internet_search_enabled;

  return [
    {
      role: "system",
      content: buildAgentSystemPrompt(agent, { internetSearchEnabled, language })
    },
    {
      role: "user",
      content: buildAgentUserPrompt(agent, snapshot, {
        privateToolContext: options.privateToolContext ?? "",
        internetSearchEnabled
      })
    }
  ];
}

function buildAgentBaseMessages(
  agent: AgentDefinition,
  snapshot: RoundSnapshot,
  options: {
    privateToolContext?: string;
    internetSearchEnabled?: boolean;
    language?: OutputLanguage;
  } = {}
): BaseMessage[] {
  const language = options.language ?? snapshot.language ?? "en";
  const internetSearchEnabled = options.internetSearchEnabled ?? snapshot.internet_search_enabled;

  return [
    new SystemMessage(buildAgentSystemPrompt(agent, { internetSearchEnabled, language })),
    new HumanMessage(buildAgentUserPrompt(agent, snapshot, {
      privateToolContext: options.privateToolContext ?? "",
      internetSearchEnabled
    }))
  ];
}

function baseMessagesToOpenRouter(messages: BaseMessage[]): OpenRouterChatMessage[] {
  return messages.map((message) => {
    if (SystemMessage.isInstance(message)) {
      return { role: "system", content: message.text };
    }

    if (HumanMessage.isInstance(message)) {
      return { role: "user", content: message.text };
    }

    if (AIMessage.isInstance(message)) {
      return {
        role: "assistant",
        content: message.text,
        tool_calls: (message.tool_calls ?? []).map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.args ?? {})
          }
        }))
      };
    }

    if (ToolMessage.isInstance(message)) {
      return {
        role: "tool",
        content: message.text,
        tool_call_id: message.tool_call_id,
        name: message.name
      };
    }

    return { role: "user", content: message.text };
  });
}

function buildAgentSystemPrompt(
  agent: AgentDefinition,
  options: { internetSearchEnabled: boolean; language: OutputLanguage }
): string {
  const otherAgents = AGENTS.filter((item) => item.name !== agent.name).map((item) => item.name);

  return `You are ${agent.name}, one of three MAGI deliberation agents.

Display name: ${agent.displayName}
Role: ${agent.role}
Focus: ${agent.focus.join(", ")}
Priority: ${agent.priority.join(", ")}

You are participating in a synchronized MAGI discussion round.
Target output language: ${options.language}. Write shared_explanation, objections_to_others, persuasion_message, and what_would_change_my_mind in this language.
Tool availability: internet_search is ${options.internetSearchEnabled ? "enabled" : "disabled"}.

Rules:
- You must strictly act as ${agent.name}. Keep your evaluation aligned with this role, focus, and priority.
- You are debating with the other two MAGI agents: ${otherAgents.join(", ")}.
- Challenge prior arguments, try to persuade the other agents, and be willing to change your decision if their evidence is stronger.
- Evaluate only the immutable MAGI round snapshot provided by the user message, plus any private same-round tool results returned to you.
- Do not assume you can see another agent's same-round output, tool request, tool result, confidence, or hidden thinking.
- Provide a discussion-visible explanation that future rounds may inspect.
- If internet_search is enabled and you need search before your final answer, call the available tool.
- If internet_search is disabled, do not request tools; reason only from the provided snapshot and your existing knowledge.
- If same-round tool results are provided, use them before producing your final answer.

Return exactly one JSON object. Do not include markdown.
- Output JSON only, with exactly these keys:
  agent, decision, confidence, shared_explanation, objections_to_others,
  persuasion_message, what_would_change_my_mind, tool_requests.
- decision must be "yes" or "no".
- confidence must be a number from 0 to 1.
- tool_requests must be an array. Use [] when no tool call is needed or tools are disabled.

Required JSON Schema:
${JSON.stringify(agentOutputJsonSchema(agent.name, otherAgents), null, 2)}
`;
}

function buildAgentUserPrompt(
  agent: AgentDefinition,
  snapshot: RoundSnapshot,
  options: { privateToolContext: string; internetSearchEnabled: boolean }
): string {
  return `Evaluate this immutable MAGI round snapshot.

Snapshot:
${JSON.stringify(snapshot, null, 2)}
${options.privateToolContext ? `\nPrivate same-round tool context visible only to ${agent.name}:\n${options.privateToolContext}\n\nNow produce the final JSON answer. Do not request the same search again unless the results are insufficient.` : ""}`;
}

function agentOutputJsonSchema(agentName: AgentDefinition["name"], otherAgents: AgentDefinition["name"][]) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "agent",
      "decision",
      "confidence",
      "shared_explanation",
      "objections_to_others",
      "persuasion_message",
      "what_would_change_my_mind",
      "tool_requests"
    ],
    properties: {
      agent: { const: agentName },
      decision: { type: "string", enum: ["yes", "no"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      shared_explanation: { type: "string", minLength: 1 },
      objections_to_others: {
        type: "object",
        additionalProperties: { type: "string" },
        properties: Object.fromEntries(otherAgents.map((name) => [name, { type: "string" }]))
      },
      persuasion_message: { type: "string" },
      what_would_change_my_mind: { type: "string" },
      tool_requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["tool", "query"],
          properties: {
            tool: { const: "internet_search" },
            query: { type: "string", minLength: 1 }
          }
        }
      }
    }
  };
}

function normalizeToolRequests(requests: ToolRequest[]): ToolRequest[] {
  const seen = new Set<string>();
  const normalized: ToolRequest[] = [];

  for (const request of requests) {
    const query = request.query.trim();
    if (request.tool !== "internet_search" || !query) {
      continue;
    }

    const key = query.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ tool: "internet_search", query });
  }

  return normalized;
}

function parseToolCalls(rawToolCalls: OpenRouterRawToolCall[]): ParsedToolCall[] {
  return rawToolCalls.map((rawCall, index) => {
    const rawArgs = rawCall.function?.arguments ?? {};
    let args: Record<string, unknown>;

    if (typeof rawArgs === "string") {
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) as Record<string, unknown> : {};
      } catch {
        args = { query: rawArgs };
      }
    } else {
      args = rawArgs;
    }

    return {
      id: rawCall.id ?? `tool_call_${index}`,
      name: rawCall.function?.name ?? "",
      args
    };
  });
}

function toolRequestFromCall(toolCall: ParsedToolCall): ToolRequest | null {
  if (toolCall.name !== internetSearchToolDefinition.name) {
    return null;
  }

  const query = String(toolCall.args.query ?? "").trim();
  if (!query) {
    return null;
  }

  return {
    tool: internetSearchToolDefinition.name,
    query
  };
}

function openRouterToolSchema() {
  return [
    {
      type: "function",
      function: {
        name: internetSearchToolDefinition.name,
        description: internetSearchToolDefinition.description,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: internetSearchToolDefinition.queryDescription
            }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    }
  ];
}

function buildPrivateToolContext(toolResults: ToolHistoryEntry[]): string {
  return JSON.stringify(
    toolResults.map((entry) => ({
      request: entry.request,
      results: entry.results.map((result) => ({
        title: result.title,
        snippet: result.snippet,
        source: result.source
      }))
    })),
    null,
    2
  );
}

function createInternetSearchTool(agent: AgentDefinition, snapshot: RoundSnapshot, searchAdapter: SearchAdapter) {
  return tool(
    async ({ query }: { query: string }) => {
      const request: ToolRequest = { tool: internetSearchToolDefinition.name, query: query.trim() };
      const results = request.query ? await searchAdapter.search(request.query, agent.name, snapshot.round) : [];
      const entry: ToolHistoryEntry = {
        round: snapshot.round,
        requestingAgent: agent.name,
        request,
        results
      };
      return JSON.stringify(entry);
    },
    {
      name: internetSearchToolDefinition.name,
      description: internetSearchToolDefinition.description,
      schema: internetSearchToolDefinition.schema
    }
  );
}

function extractToolResults(messages: BaseMessage[]): ToolHistoryEntry[] {
  return messages
    .filter(ToolMessage.isInstance)
    .map((message) => {
      try {
        return JSON.parse(message.text) as ToolHistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ToolHistoryEntry => Boolean(entry));
}

function extractToolRequests(messages: BaseMessage[]): Array<ToolRequest & { iteration: number }> {
  const requests: Array<ToolRequest & { iteration: number }> = [];
  let iteration = 0;

  for (const message of messages) {
    if (!AIMessage.isInstance(message)) {
      continue;
    }

    iteration += 1;
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.name !== "internet_search") {
        continue;
      }

      const query = String(toolCall.args?.query ?? "").trim();
      if (!query) {
        continue;
      }

      requests.push({ tool: "internet_search", query, iteration });
    }
  }

  return requests;
}

function extractThinking(message: OpenRouterMessage): string {
  const direct = message.reasoning_content ?? message.reasoning ?? message.thinking;
  if (direct) {
    return direct;
  }

  const parts = (message.reasoning_details ?? [])
    .map((detail) => detail.text ?? detail.summary ?? (detail.data ? "[encrypted reasoning returned by provider]" : ""))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.join("\n\n");
}

function joinThinkingAndContent(thinking: string, content: string): string {
  return thinking ? `<think>${thinking}</think>\n${content}` : content;
}

function agentSettings(agent: AgentDefinition): { temperature: number; topP: number } {
  const prefix = `MAGI_${agent.name.toUpperCase()}_`;
  return {
    temperature: Number(process.env[`${prefix}TEMPERATURE`] ?? defaultTemperature(agent.name)),
    topP: Number(process.env[`${prefix}TOP_P`] ?? defaultTopP(agent.name))
  };
}

function defaultTemperature(agentName: AgentDefinition["name"]): number {
  if (agentName === "melchior") {
    return 0.15;
  }
  if (agentName === "balthasar") {
    return 0.35;
  }
  return 0.7;
}

function defaultTopP(agentName: AgentDefinition["name"]): number {
  if (agentName === "melchior") {
    return 0.85;
  }
  if (agentName === "balthasar") {
    return 0.9;
  }
  return 0.95;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isLlmDebugEnabled(): boolean {
  return envBool("MAGI_LLM_DEBUG", envBool("MAGI_DEBUG", process.env.NODE_ENV === "development"));
}
