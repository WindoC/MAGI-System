# AGENTS.md

## Project Rules

- Use the built-in file editing tools for source changes. Prefer `apply_patch` for manual edits.
- Do not introduce a Python/FastAPI backend. The backend for this project is Next.js Route Handlers.
- The discussion engine must use LangGraph JS (`@langchain/langgraph`) for graph orchestration.
- The LangGraph topology must match `10a_magi_system-search.py`: `initial_search -> create_round_snapshot -> melchior/balthasar/casper` fan-out, then fan-in to `record_round`, conditional route to `next_round` or `finalize`.
- Agent turn tool execution must use LangGraph's built-in `ToolNode` pattern: `agent -> tools -> agent -> finalize_agent`. Do not replace it with a hand-written while-loop tool dispatcher.
- Keep all tool behavior read-only. Do not add features that execute shell commands, modify external systems, call external write APIs, control devices, or trigger workflows.
- Preserve transparent auditability: user query, search requests, search results, agent outputs, objections, persuasion messages, raw model thinking, and final decision metadata must remain inspectable.
- Raw model thinking may be shown to the user, but it must not be included in future agent snapshots.
- All agents in a round must receive the same immutable snapshot.
- Search results from a round become visible only in later snapshots after all agents finish the current round.
- If an agent uses `internet_search` during its own turn, the same-round result may be used only by that requesting agent as private tool context; it must not be exposed to peer agents until the next round snapshot.
- Invalid or malformed model output must become an agent `ERROR` result for that round. Do not convert parser failures into `NO`.
- `ERROR` agent outputs do not count as YES/NO votes. One `ERROR` can still allow consensus between the two valid agents; two `ERROR` outputs in a round must end the discussion with final result `ERROR`.
- If two consecutive completed rounds have identical decisions for every agent, end the discussion with `stable_vote` instead of running more rounds.
- OpenRouter agent requests must include a system message with the required JSON Schema for agent output.
- Backend core logic should return language-neutral final decision metadata. User-facing localization belongs in the frontend.
- Internet search is user-controlled and defaults to disabled.

## Architecture

- Frontend: Next.js app router.
- Backend: Next.js API routes / route handlers.
- Graph engine: LangGraph JS.
- Storage: SQLite through the Node.js runtime.
- Search: read-only OpenRouter web search exposed through the `internet_search` tool contract.
- LLM: OpenRouter chat completions.

Default OpenRouter models:

- Melchior: `qwen/qwen3.6-27b`
- Balthasar: `google/gemma-4-31b-it:free`
- Casper: `openai/gpt-oss-20b:free`

## Development Workflow

1. Read `PRD.md` before changing behavior.
2. Check `TASKS.md` for the current implementation direction.
3. Keep changes scoped to the requested task.
4. Add or update tests for behavior changes.
5. Run verification before completing work:

```bash
npm test
npx tsc --noEmit
npm run build
```

Use the OpenRouter integration test when changing model prompting, parsing, or adapter behavior:

```powershell
$env:RUN_OPENROUTER_INTEGRATION='1'; npm run test:openrouter
```

## Implementation Notes

- Prefer existing local modules under `src/magi` unless a change requires moving code.
- Do not remove audit fields to simplify implementation.
- Do not let one agent observe another agent's same-round output, tool request, tool result, or confidence.
- If a model returns malformed JSON, invalid `decision` / `confidence`, or an empty `shared_explanation`, preserve the raw output in audit data and mark that agent output as `decision: "error"` with `parse_error: true`.
- Keep the agent output JSON Schema in the system prompt when changing model prompting.
- Do not use dummy/local fallback results for enabled internet search. If OpenRouter search fails, preserve an inspectable empty result set instead of fabricating sources.
- Tool calling must support multiple tool calls in one model response and multiple model/tool iterations in one round, bounded by `MAGI_MAX_TOOL_ITERATIONS`.
- Backend debug logs for LLM requests must print complete structured payloads, not collapsed `[Object]` values.
- The streaming UI should update agent colors, detail discussion rows, thinking logs, and search/tool history as soon as each state update arrives.
- Agent status colors: YES/agree is green, NO/reject is red, ERROR is gray, tool-use/active tool state is blue, and model/tool processing should use a breathing/pulsing indicator.
