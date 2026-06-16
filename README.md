# MAGI System MVP

Transparent read-only multi-agent deliberation system based on `PRD.md`.

## Runtime

- Frontend/backend: Next.js with API routes
- Discussion engine: LangGraph JS (`@langchain/langgraph`)
- Storage: SQLite through Node 22 `node:sqlite`
- Search: read-only OpenRouter web search through `perplexity/sonar-pro-search`
- LLM: OpenRouter chat completions

Configured default agent models:

- Melchior: `qwen/qwen3.6-27b`
- Balthasar: `google/gemma-4-31b-it:free`
- Casper: `openai/gpt-oss-20b:free`

## Commands

```bash
npm install
npm test
npm run test:openrouter
npm run dev
```

Open `http://localhost:3000`.

The system only exposes read-only internal search tooling. It does not execute shell commands, modify external systems, call write APIs, or automate external environments.

## Decision Logic

- Agent decisions are `yes`, `no`, or `error`.
- Malformed model output is recorded as `error`, including invalid JSON, invalid `decision` / `confidence`, or an empty `shared_explanation`.
- `error` does not count as a YES/NO vote.
- If one agent returns `error`, the other two agents can still reach consensus when they agree.
- If two agents return `error` in the same round, the discussion ends with final result `error`.
- If every agent keeps the same decision for two consecutive rounds, the discussion ends with `stable_vote`.
- Final decision metadata includes vote breakdown plus overall mind-change and agent-error counts.

OpenRouter requests use a system message containing the required agent-output JSON Schema.

Backend final decisions are language-neutral metadata. The frontend localizes final summaries and labels.

Internet search is disabled by default. When enabled, agents may use the read-only `internet_search` tool backed by OpenRouter web search; same-round tool results remain private to that agent until the next round snapshot. Failed searches return an inspectable empty result set instead of dummy local results.

## LangGraph Flow

The backend graph follows `10a_magi_system-search.py`:

```text
START
  -> initial_search
  -> create_round_snapshot
  -> melchior ┐
  -> balthasar ├-> record_round
  -> casper   ┘
  -> route_after_round
      -> next_round -> create_round_snapshot
      -> finalize -> END
```

The three agent nodes fan out from the same immutable snapshot and fan in only after all complete.

Each agent turn uses a nested LangGraph tool loop:

```text
agent -> tools -> agent -> finalize_agent
```

The `tools` node is LangGraph's built-in `ToolNode`, so a model response can request multiple `internet_search` calls in parallel and can loop through multiple LLM/tool iterations within the same round, bounded by `MAGI_MAX_TOOL_ITERATIONS`.

## Debugging

LangGraph node tracing is printed to the backend console in development mode.

Controls:

```powershell
$env:MAGI_GRAPH_DEBUG='1' # force graph node logs on
$env:MAGI_GRAPH_DEBUG='0' # force graph node logs off
```

The logs include `node:start` and `node:end` events for each LangGraph node, compact state summaries, update summaries, and node duration. LangGraph also supports native stream modes such as `updates`, `values`, and `debug` through `graph.stream(...)`; this app uses explicit node tracing so regular Next.js API calls produce readable backend console output.

OpenRouter generation can be configured with:

```powershell
$env:OPENROUTER_API_KEY='...'
$env:OPENROUTER_BASE_URL='https://openrouter.ai/api/v1'
$env:OPENROUTER_SEARCH_MODEL='perplexity/sonar-pro-search'
$env:OPENROUTER_SEARCH_MAX_RESULTS='5'
$env:MAGI_NUM_PREDICT='1800'
$env:MAGI_REPAIR_NUM_PREDICT='1200'
$env:OPENROUTER_REASONING='1'
$env:MAGI_LLM_DEBUG='1'
```

When `MAGI_LLM_DEBUG` is enabled, OpenRouter request logs print the full JSON payload so model inputs can be audited without `[Object]` truncation.
