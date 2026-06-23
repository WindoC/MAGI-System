# MAGI System MVP

Transparent read-only multi-agent deliberation system based on `PRD.md`.

## Runtime

- Frontend/backend: Next.js with API routes
- Discussion engine: LangGraph JS (`@langchain/langgraph`)
- Storage: SQLite through Node 22 `node:sqlite`
- Search: read-only OpenRouter web search through `perplexity/sonar-pro-search`
- LLM: OpenRouter chat completions

Configured default agent models:

- Melchior: `nvidia/nemotron-3-super-120b-a12b:free`
- Balthasar: `google/gemma-4-31b-it:free`
- Casper: `openai/gpt-oss-120b:free`

## Commands

```bash
npm install
npm test
npm run test:openrouter
npm run dev
```

Open `http://localhost:3000`.

The system only exposes read-only internal search tooling. It does not execute shell commands, modify external systems, call write APIs, or automate external environments.

## Authentication and Quota

The UI requires an OAuth2/OIDC login before a user can start a discussion. The server stores the authenticated session in a signed `HttpOnly` cookie and only exposes a safe user/session summary to the browser.

Required OAuth2 settings:

```powershell
$env:SESSION_SECRET='replace-with-a-long-random-secret'
$env:MAGI_AUTH_ENABLED='true'
$env:MAGI_QUOTA_ENABLED='true'
$env:OAUTH_CLIENT_ID='...'
$env:OAUTH_CLIENT_SECRET='...'
$env:OAUTH_AUTHORIZATION_URL='https://identity.example.com/oauth2/authorize'
$env:OAUTH_TOKEN_URL='https://identity.example.com/oauth2/token'
$env:OAUTH_USERINFO_URL='https://identity.example.com/oauth2/userinfo'
$env:OAUTH_REDIRECT_URI='http://localhost:3000/api/auth/callback'
$env:OAUTH_SCOPE='openid profile email'
$env:QUOTA_API_URL='http://localhost:8000'
$env:MAGI_QUOTA_APP='magi-system'
$env:MAGI_QUOTA_FEATURE='resolve'
```

For local-only testing without SSO or quota API calls:

```powershell
$env:MAGI_AUTH_ENABLED='false'
$env:MAGI_QUOTA_ENABLED='false'
```

With auth disabled, the app uses a local test session. Optional local identity labels can be set with `MAGI_LOCAL_USER_ID`, `MAGI_LOCAL_USER_EMAIL`, and `MAGI_LOCAL_USER_NAME`.

Quota endpoints are available locally at `GET /api/auth/quota` and `POST /api/auth/quota/debit`. When `QUOTA_API_URL` is set and `MAGI_QUOTA_ENABLED` is not `false`, quota is checked against Windo-C Accounts with the authenticated user's OAuth access token. Set `QUOTA_API_URL` to the Accounts base URL, for example `http://localhost:8000` in development or `https://accounts.windo-c.com` in production. Discussion routes call `POST /api/quota/check` before running and `POST /api/quota/consume` only after a successful run, using `MAGI_QUOTA_APP` and `MAGI_QUOTA_FEATURE` without sending a user id. Page/session refresh does not call the quota service; it returns the cached session value only. Use `GET /api/auth/quota` when the UI explicitly needs a fresh quota read. Without `QUOTA_API_URL`, the app falls back to signed local session quota initialized from `MAGI_DEFAULT_QUOTA`.

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

Internet search is disabled by default per discussion request. Deployments can also force it off with `MAGI_ALLOW_INTERNET_SEARCH=false`; when the environment allows it and the request enables it, agents may use the read-only `internet_search` tool backed by OpenRouter web search. Same-round tool results remain private to that agent until the next round snapshot. Failed searches return an inspectable empty result set instead of dummy local results.

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
$env:MAGI_ALLOW_INTERNET_SEARCH='true'
$env:OPENROUTER_SEARCH_MODEL='perplexity/sonar-pro-search'
$env:OPENROUTER_SEARCH_MAX_RESULTS='5'
$env:MAGI_NUM_PREDICT='1800'
$env:MAGI_REPAIR_NUM_PREDICT='1200'
$env:OPENROUTER_REASONING='1'
$env:MAGI_LLM_DEBUG='1'
```

When `MAGI_LLM_DEBUG` is enabled, OpenRouter request logs print the full JSON payload so model inputs can be audited without `[Object]` truncation.
