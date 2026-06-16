# TASKS

## Current Direction

Build MAGI as a Next.js application with both frontend and backend hosted in the same project. The discussion engine uses LangGraph JS (`@langchain/langgraph`) rather than a custom-only round loop or a Python/FastAPI backend.

## Completed

- Created a Next.js UI for submitting a query and inspecting final decision, search history, discussion rounds, and raw thinking.
- Added OpenRouter model support for:
  - `qwen/qwen3.6-27b`
  - `google/gemma-4-31b-it:free`
  - `openai/gpt-oss-20b:free`
- Added read-only internet search adapter exposed through the `internet_search` tool contract.
- Added SQLite persistence through Node.js `node:sqlite`.
- Added a LangGraph JS `StateGraph` execution path for the full deliberation lifecycle.
- Added tests for consensus, majority vote, snapshot isolation, search persistence, raw-thinking exclusion, parsing, search, and storage.
- Added optional OpenRouter integration coverage for the three requested agents.

## MVP Completion Tasks

1. Use `@langchain/langgraph` and `@langchain/core` dependencies. Done.
2. Model graph nodes for:
   - initial search
   - create immutable round snapshot
   - run all three agents from the same snapshot
   - execute read-only tool requests after all agents complete
   - aggregate round records
   - consensus / max-round routing
   - finalization
   Done.
3. Preserve all existing MAGI invariants in tests:
   - agents cannot see current-round outputs
   - current-round tool results enter only the next snapshot
   - raw thinking is user-visible but excluded from future agent snapshots
   - search results persist in the shared search pool
   - consensus terminates immediately
   - max rounds triggers majority vote
   Done.
4. Update API routes to invoke the LangGraph-backed engine. Done.
5. Update README commands and architecture notes after the LangGraph migration. Done.
6. Keep the system read-only: no shell execution, no external write APIs, no automation side effects. Ongoing rule.

## Verification Commands

```bash
npm test
npx tsc --noEmit
npm run build
```

Optional OpenRouter model integration:

```powershell
$env:RUN_OPENROUTER_INTEGRATION='1'; npm run test:openrouter
```
