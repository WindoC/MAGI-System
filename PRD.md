# MAGI System MVP PRD v1.0

## 1. Overview

MAGI is a transparent multi-agent deliberation system inspired by the MAGI supercomputer system.

Three independent AI agents discuss a topic, challenge each other's conclusions, gather information, and attempt to persuade one another before reaching a final decision.

The system is designed as a read-only deliberation platform.

The system never modifies external systems, executes commands, performs automation, or changes the environment.

Its purpose is to improve decision quality while exposing the complete reasoning and discussion process to the user.

---

# 2. Goals

## Primary Goals

* Multi-agent decision making
* Transparent reasoning process
* Agent disagreement and persuasion
* User visibility into agent thinking
* Structured consensus building
* Search-assisted discussion

---

## Non-Goals

The MVP must not:

* Execute shell commands
* Modify files
* Control devices
* Trigger workflows
* Call automation systems
* Access external write APIs
* Change external environments

The system is strictly read-only.

---

# 3. Core Principles

## Transparency

Users must be able to inspect:

* User query
* Search requests
* Search results
* Agent decisions
* Agent explanations
* Agent disagreements
* Agent persuasion attempts
* Raw model thinking

---

## Agent Independence

Agents are allowed to disagree.

Agents should challenge assumptions.

Agents should attempt to persuade others.

Consensus should be earned through discussion.

---

## Information Fairness

All agents receive identical information at the beginning of each discussion round.

All agents in a round begin from the same immutable snapshot.

If an agent uses `internet_search` during its own turn, those results are private to that agent for finalizing that same turn. Other agents cannot see that same-round tool request or result until the round is complete and the next snapshot is created.

---

## Deterministic Round Progression

Discussion proceeds in synchronized rounds.

No agent may advance to the next round until all agents complete the current round.

---

# 4. Agent Definitions

## Melchior

Role:

Scientific and rational evaluator.

Focus:

* Facts
* Evidence
* Logic
* Consistency

Priority:

1. Correctness
2. Evidence quality
3. Logical consistency

---

## Balthasar

Role:

Human-centric evaluator.

Focus:

* Human impact
* Safety
* Risk
* Social consequences

Priority:

1. Human impact
2. Safety
3. Risk reduction

---

## Casper

Role:

Adversarial evaluator.

Focus:

* Failure scenarios
* Unknown risks
* Edge cases
* Alternative interpretations

Priority:

1. Failure prevention
2. Survivability
3. Alternative strategies

---

# 5. High Level Flow

```text
User Query
      ↓
Optional Initial Search
      ↓
Create Round Snapshot
      ↓
Melchior / Balthasar / Casper in parallel
      ↓
Record Round
      ↓
Route After Round
      ├─ Next Round
      └─ Finalize
      ↓
Final Decision
```

---

# 6. Tool System

## MVP Tool List

### Internal Search

Purpose:

Retrieve information relevant to the discussion topic through a read-only search adapter.

Internet search is user-controlled and defaults to disabled.

MVP implementation:

* Internet search through OpenRouter web search
* Default search model: `perplexity/sonar-pro-search`
* No dummy or local fabricated results when enabled internet search fails
* No write APIs
* No external environment changes

Request:

```json
{
  "tool": "internet_search",
  "query": "..."
}
```

Response:

```json
{
  "results": [...]
}
```

---

## Future Tools

Potential future additions:

* OpenClaw Memory Search
* Local Knowledge Search
* Vector Search
* Document Search

All tools must remain read-only.

---

# 7. Initial Search Phase

When internet search is enabled, before discussion begins:

```text
query
    ↓
internet_search
    ↓
search_before_discuss
```

Result becomes part of the initial discussion snapshot.

When internet search is disabled, the initial search phase is skipped and agents must not request tools.

---

# 8. Round-Based Discussion Model

The discussion engine operates using synchronized rounds.

Each round begins with an immutable snapshot.

Agents cannot observe events occurring within the same round.

---

# 9. Snapshot Model

At the start of each round, the system generates a snapshot:

```json
{
  "round": 3,

  "query": "...",

  "shared_search_results": [...],

  "discussion_history": [...],

  "tool_history": [...]
}
```

The snapshot remains immutable throughout the round.

---

# 10. Agent Isolation

During a discussion round, agents are isolated.

Agents cannot observe:

* another agent's current round output
* another agent's current round decision
* another agent's current round search requests
* another agent's current round search results
* another agent's current round confidence

Agents only see information included in the current snapshot.

New information becomes available only at the beginning of the next round.

---

# 11. Round Lifecycle

## Step 1

System creates round snapshot.

---

## Step 2

Snapshot is distributed to all agents.

---

## Step 3

Agents independently evaluate the snapshot through fan-out LangGraph nodes:

* Melchior
* Balthasar
* Casper

All three nodes must start from the same immutable snapshot and fan in only after all three complete.

Inside each agent node, tool execution must use LangGraph's built-in `ToolNode` loop:

```text
agent -> tools -> agent -> finalize_agent
```

The model may request multiple read-only `internet_search` tool calls in one response. The agent may perform multiple LLM/tool iterations in the same round up to the configured maximum.

Agents may:

* make decisions
* challenge previous arguments
* request searches
* attempt persuasion

---

## Step 4

Agents submit outputs.

---

## Step 5

System executes tool requests.

---

## Step 6

System records the round:

* agent outputs
* tool requests
* tool results

---

## Step 7

System routes after the round:

* finalize if termination conditions are met
* otherwise increment round and generate the next round snapshot

---

# 12. Agent Output Format

Each agent produces:

```json
{
  "agent": "melchior",

  "decision": "yes",

  "confidence": 0.85,

  "shared_explanation": "...",

  "objections_to_others": {
    "balthasar": "...",
    "casper": "..."
  },

  "persuasion_message": "...",

  "what_would_change_my_mind": "...",

  "tool_requests": []
}
```

`decision` must be one of:

* `yes`
* `no`
* `error`

Models are prompted to return only `yes` or `no`; the system produces `error` when the model call or output structure is invalid.

Invalid output includes:

* invalid or unextractable JSON
* missing required fields
* invalid `decision`
* invalid `confidence`
* empty or whitespace-only `shared_explanation`
* invalid `tool_requests`

Invalid output must be recorded as an agent `ERROR` result for that round. It must not be converted into a low-confidence `NO`.

---

# 13. Thinking Handling

## Raw Thinking

If the underlying model exposes chain-of-thought output:

Visibility:

* User visible
* Not visible to agents
* Not included in future rounds
* Not included in snapshots

Purpose:

* Transparency
* Debugging
* Auditability

---

## Shared Explanation

Agents must provide a discussion-visible explanation.

Visibility:

* User visible
* Agent visible
* Included in future snapshots

Purpose:

* Discussion
* Persuasion
* Consensus building

---

# 14. Search Transparency

Search activity is fully transparent to users.

Users can inspect:

* requesting agent
* search query
* search results

---

# 15. Search Persistence

Search results obtained during any round become part of the permanent discussion record.

They are added to the shared search pool.

Future rounds may reuse existing search results without repeating the same search.

Search results remain available throughout the lifetime of the discussion.

---

# 16. Discussion History

The system maintains:

```text
Round 1
Round 2
Round 3
...
```

For each round:

* decisions
* confidence
* explanations
* objections
* persuasion attempts
* search requests
* search results

are permanently recorded.

---

# 17. Consensus Rules

Consensus exists when:

```text
YES YES YES
```

or

```text
NO NO NO
```

Consensus also exists when exactly one agent is `ERROR` and the two valid agents agree:

```text
YES YES ERROR
```

or

```text
NO NO ERROR
```

`ERROR` does not count as a YES/NO vote.

Consensus immediately ends discussion.

---

# 18. Discussion Termination Rules

Discussion ends only when:

## Condition 1

Consensus reached.

---

## Condition 2

Two or more agents return `ERROR` in the same round.

In this case, discussion must terminate with final result `ERROR`.

---

## Condition 3

Two consecutive completed rounds have identical decisions for every agent.

In this case, discussion must terminate with a `stable_vote` final decision using the latest round's YES/NO vote counts. `ERROR` still does not count as a YES/NO vote.

---

## Condition 4

Maximum round count reached.

Example:

```yaml
max_rounds: 5
```

After Round 5:

Discussion must terminate.

No other termination conditions exist.

---

# 19. Final Decision Logic

## Consensus

If all agents agree:

```json
{
  "result": "yes",
  "method": "consensus"
}
```

or

```json
{
  "result": "no",
  "method": "consensus"
}
```

---

## Consensus With One ERROR

If one agent returns `ERROR` and the two valid agents agree:

```json
{
  "result": "yes",
  "method": "consensus"
}
```

or

```json
{
  "result": "no",
  "method": "consensus"
}
```

The `ERROR` output remains visible in the audit trail and vote breakdown but is not counted as a YES/NO vote.

---

## Too Many Errors

If two or more agents return `ERROR` in the same round:

```json
{
  "result": "error",
  "method": "error"
}
```

---

## Voting

If discussion reaches maximum rounds without consensus:

Majority voting applies. `ERROR` outputs are ignored for YES/NO majority calculation.

Example:

```text
YES YES NO
```

Result:

```json
{
  "result": "yes",
  "method": "majority_vote"
}
```

---

## Stable Vote

If every agent keeps the same decision for two consecutive completed rounds:

```json
{
  "result": "yes",
  "method": "stable_vote"
}
```

or

```json
{
  "result": "no",
  "method": "stable_vote"
}
```

The system should end immediately instead of running additional rounds.

---

Final decision metadata must include:

* final result
* method
* round count
* vote breakdown for YES, NO, and ERROR
* total agent mind-change count
* total agent ERROR count
* final summary

---

# 20. User Interface Requirements

## Query View

Display:

* original query
* language selector (`en`, `zh-TW`, `ja`)
* maximum round control
* internet search enable/disable control, default disabled
* run control in the same input row as the above controls

---

## Search View

Display:

* search request
* search result
* requesting agent

---

## Round View

Display per round:

* agent name
* decision
* confidence
* explanation
* objections
* persuasion attempts
* tool requests
* tool results

The left-side agent decision view must update immediately as each agent output arrives during a round. It must not wait for the whole round to finish.

Agent color/status rules:

* YES / agree: green
* NO / reject: red
* ERROR: gray
* tool-use / active tool state: blue
* model or tool processing: breathing/pulsing indicator

---

## Thinking View

Display:

* raw chain-of-thought
* grouped by agent
* grouped by round
* hidden by default under the corresponding agent discussion entry and revealed with a dropdown

User visible only.

Thinking must not be placed in a separate global section disconnected from the relevant discussion output.

---

## Final Decision View

Display:

* final result
* consensus or voting
* round count
* vote breakdown
* overall mind-change count
* overall agent ERROR count
* final summary

---

## Detail Panel

The main left decision interface should occupy the full viewport when the detail panel is hidden and should always fit within one page.

The right detail panel is hidden by default. Users open it with a right-edge icon button. The panel must:

* have its own scroll area
* not cause the left interface to overflow vertically
* support docked and full-page display modes
* update discussion rows and search/tool history as streaming state arrives

---

# 21. MVP Technical Architecture

Frontend:

* Next.js

Backend:

* Next.js API Routes / Route Handlers

Discussion Engine:

* LangGraph JS (`@langchain/langgraph`)

Storage:

* SQLite through the Node.js runtime

Search:

* Read-only Internet Search Adapter exposed to agents as `internet_search`
* OpenRouter web plugin using `perplexity/sonar-pro-search`
* Failed searches return transparent empty result sets instead of dummy local results

LLM:

* OpenRouter

OpenRouter requests must include a system message containing the required agent-output JSON Schema.

Backend final decisions must remain language-neutral metadata. Frontend code is responsible for localizing final summaries and labels.

---

# 22. LangGraph State

```typescript
type MagiState = {
  query: string;

  current_round: number;

  max_rounds: number;

  search_before_discuss: SearchResult[];

  shared_search_pool: SearchResult[];

  discussion_history: RoundRecord[];

  tool_history: ToolHistoryEntry[];

  user_audit_log: Array<Record<string, unknown>>;

  thinking_log?: ThinkingLog[];

  language?: "en" | "zh-TW" | "ja";

  internet_search_enabled?: boolean;

  final_decision: FinalDecision | null;

  pending_round_snapshot?: RoundSnapshot | null;

  pending_agent_outputs?: AgentOutput[];

  pending_tool_results?: ToolHistoryEntry[];

  pending_thinking_log?: ThinkingLog[];
};
```

---

# 23. Success Criteria

The MVP is successful when:

* Three agents can discuss independently
* Agents operate on immutable snapshots
* Agents cannot see current-round activity
* Search requests work
* Search results persist across rounds
* Search results become part of future snapshots
* Consensus detection works
* Majority voting works
* Raw thinking is visible to users
* The system remains read-only
* The entire discussion process is transparent
* The discussion engine supports future OpenClaw Memory Search integration

```
```
