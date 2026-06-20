"use client";

import { useEffect, useState } from "react";
import type { AgentName, AgentOutput, MagiState, OutputLanguage, ThinkingLog } from "../src/magi/types";

const settingsStorageKey = "magi-system:user-settings";

type AuthSessionView = {
  authenticated: boolean;
  user: { id: string; email?: string; name?: string } | null;
  quotaRemaining: number | null;
  expiresAt: string | null;
  quota?: { remaining: number; limit?: number; resetAt?: string };
};

const agentOrder: Array<{ name: AgentName; label: string; slot: string }> = [
  { name: "balthasar", label: "BALTHASAR · 2", slot: "top" },
  { name: "casper", label: "CASPER · 3", slot: "left" },
  { name: "melchior", label: "MELCHIOR · 1", slot: "right" }
];

const copy: Record<OutputLanguage, Record<string, string>> = {
  en: {
    proposal: "Proposal",
    decision: "Decision",
    standby: "Standby",
    deliberating: "Processing",
    query: "Query",
    queryPlaceholder: "Enter the query for MAGI to decide ...",
    maxRounds: "Max rounds",
    run: "Run",
    language: "Language",
    searchTool: "Internet search",
    details: "Details",
    openDetails: "Open details",
    closeDetails: "Close",
    fullscreen: "Full page",
    docked: "Docked",
    finalDecision: "Final Decision",
    searchHistory: "Search / Tool History",
    rounds: "Discussion Rounds",
    persuasion: "Persuasion",
    changeMind: "Change mind",
    thinking: "Thinking",
    tool: "Tool",
    toolUse: "Tool Use",
    caller: "Caller",
    results: "Results",
    round: "Round",
    processing: "Processing",
    yes: "YES",
    no: "NO",
    errorStatus: "ERROR",
    methodConsensus: "Consensus",
    methodMajorityVote: "Majority vote",
    methodStableVote: "Stable vote",
    methodError: "Error",
    summaryConsensus: "Consensus was reached after {rounds} round(s). Final result: {result}.",
    summaryMajorityVote: "Maximum rounds reached. Majority vote selected {result}.",
    summaryStableVote: "Agent decisions were unchanged for two consecutive rounds. Current vote selected {result}.",
    summaryError: "Decision failed: too many agents returned ERROR to produce a reliable result.",
    mindChanges: "Mind changes",
    agentErrors: "Agent errors",
    noThinking: "No raw thinking exposed by model.",
    emptyTitle: "Decision Detail Panel",
    emptyBody: "Run a query to inspect search records, discussion rounds, persuasion messages, and hidden thinking logs.",
    authTitle: "Authentication Required",
    authBody: "Sign in through the OAuth2 identity system before using MAGI.",
    signIn: "Sign in",
    signOut: "Sign out",
    signedIn: "Signed in",
    quota: "Quota",
    quotaEmpty: "Quota exhausted",
    checkingAuth: "Checking auth"
  },
  "zh-TW": {
    proposal: "提訴",
    decision: "決議",
    standby: "待機",
    deliberating: "審議中",
    query: "查詢",
    queryPlaceholder: "輸入要交由 MAGI 決議的查詢 ...",
    maxRounds: "最大回合",
    run: "決議",
    language: "語言",
    searchTool: "網路搜尋",
    details: "詳細",
    openDetails: "展開詳細",
    closeDetails: "關閉",
    fullscreen: "全頁",
    docked: "側欄",
    finalDecision: "最終決議",
    searchHistory: "搜尋 / 工具紀錄",
    rounds: "討論回合",
    persuasion: "說服",
    changeMind: "改變條件",
    thinking: "思考",
    tool: "工具",
    toolUse: "工具使用",
    caller: "呼叫者",
    results: "結果",
    round: "回合",
    processing: "處理中",
    yes: "承認",
    no: "否定",
    errorStatus: "ERROR",
    methodConsensus: "共識",
    methodMajorityVote: "多數決",
    methodStableVote: "穩定投票",
    methodError: "錯誤",
    summaryConsensus: "{rounds} 回合後達成共識。最終結果：{result}。",
    summaryMajorityVote: "已達最大回合數，依多數決選擇 {result}。",
    summaryStableVote: "連續兩回合各 AGENT 決定未改變，依目前票數選擇 {result}。",
    summaryError: "決議失敗：太多 AGENT 發生 ERROR，無法可靠產生結論。",
    mindChanges: "改變主意",
    agentErrors: "AGENT ERROR",
    noThinking: "模型沒有輸出 raw thinking。",
    emptyTitle: "決議詳細面板",
    emptyBody: "執行查詢後可檢視搜尋紀錄、討論回合、說服訊息與隱藏 thinking。",
    authTitle: "需要登入",
    authBody: "使用 MAGI 前必須先透過 OAuth2 認證系統登入。",
    signIn: "登入",
    signOut: "登出",
    signedIn: "已登入",
    quota: "配額",
    quotaEmpty: "配額不足",
    checkingAuth: "確認登入"
  },
  ja: {
    proposal: "提訴",
    decision: "決議",
    standby: "待機",
    deliberating: "審議中",
    query: "クエリ",
    queryPlaceholder: "MAGI に決定させるクエリを入力 ...",
    maxRounds: "最大ラウンド",
    run: "実行",
    language: "言語",
    searchTool: "インターネット検索",
    details: "詳細",
    openDetails: "詳細を開く",
    closeDetails: "閉じる",
    fullscreen: "全画面",
    docked: "サイド表示",
    finalDecision: "最終決定",
    searchHistory: "検索 / ツール履歴",
    rounds: "議論ラウンド",
    persuasion: "説得",
    changeMind: "判断変更条件",
    thinking: "思考",
    tool: "ツール",
    toolUse: "ツール使用",
    caller: "呼び出し元",
    results: "結果",
    round: "ラウンド",
    processing: "処理中",
    yes: "承認",
    no: "否定",
    errorStatus: "ERROR",
    methodConsensus: "合意",
    methodMajorityVote: "多数決",
    methodStableVote: "安定投票",
    methodError: "エラー",
    summaryConsensus: "{rounds} ラウンド後に合意しました。最終結果: {result}。",
    summaryMajorityVote: "最大ラウンドに達したため、多数決で {result} を選択しました。",
    summaryStableVote: "2 ラウンド連続で各 AGENT の判断が変わらなかったため、現在の票数で {result} を選択しました。",
    summaryError: "決議失敗: ERROR の AGENT が多すぎるため、信頼できる結論を出せません。",
    mindChanges: "判断変更",
    agentErrors: "AGENT ERROR",
    noThinking: "モデルは raw thinking を出力していません。",
    emptyTitle: "決定詳細パネル",
    emptyBody: "クエリを実行すると、検索履歴、議論ラウンド、説得メッセージ、非表示の thinking を確認できます。",
    authTitle: "認証が必要です",
    authBody: "MAGI を使用する前に OAuth2 認証システムでサインインしてください。",
    signIn: "サインイン",
    signOut: "サインアウト",
    signedIn: "サインイン済み",
    quota: "クォータ",
    quotaEmpty: "クォータ不足",
    checkingAuth: "認証確認中"
  }
};

export default function Home() {
  const [query, setQuery] = useState("");
  const [maxRounds, setMaxRounds] = useState(3);
  const [enableInternetSearch, setEnableInternetSearch] = useState(false);
  const [language, setLanguage] = useState<OutputLanguage>("en");
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailFullscreen, setDetailFullscreen] = useState(false);
  const [state, setState] = useState<MagiState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSessionView | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const t = copy[language];
  const quotaRemaining = authSession?.quota?.remaining ?? authSession?.quotaRemaining ?? null;
  const canRun = authSession?.authenticated === true && (quotaRemaining === null || quotaRemaining > 0);

  useEffect(() => {
    const savedSettings = readStoredSettings();
    if (!savedSettings) {
      setSettingsLoaded(true);
      return;
    }

    setLanguage(savedSettings.language);
    setMaxRounds(savedSettings.maxRounds);
    setEnableInternetSearch(savedSettings.enableInternetSearch);
    setSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }

    localStorage.setItem(
      settingsStorageKey,
      JSON.stringify({
        language,
        maxRounds,
        enableInternetSearch
      })
    );
  }, [language, maxRounds, enableInternetSearch, settingsLoaded]);

  useEffect(() => {
    void refreshSession();
  }, []);

  async function refreshSession() {
    setAuthLoading(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Session check failed");
      }
      setAuthSession((await response.json()) as AuthSessionView);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Session check failed");
      setAuthSession({ authenticated: false, user: null, quotaRemaining: null, expiresAt: null });
    } finally {
      setAuthLoading(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthSession({ authenticated: false, user: null, quotaRemaining: null, expiresAt: null });
  }

  async function runDiscussion() {
    if (!canRun) {
      setError(authSession?.authenticated ? t.quotaEmpty : t.authTitle);
      return;
    }

    setLoading(true);
    setError("");
    setState(null);

    try {
      const response = await fetch("/api/discussions/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, maxRounds, enableInternetSearch, language })
      });

      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? "Discussion failed");
      }

      if (!response.body) {
        throw new Error("Streaming response was empty.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          const event = JSON.parse(line) as { type: "state" | "done" | "error"; state?: MagiState; error?: string };
          if (event.state) {
            const incomingState = event.state;
            setState((previous) => event.type === "done" ? incomingState : mergeMagiUiState(previous, incomingState));
          }
          if (event.type === "error") {
            throw new Error(event.error ?? "Discussion failed");
          }
        }
      }

      if (buffer.trim()) {
        const event = JSON.parse(buffer) as { type: "state" | "done" | "error"; state?: MagiState; error?: string };
        if (event.state) {
          const incomingState = event.state;
          setState((previous) => event.type === "done" ? incomingState : mergeMagiUiState(previous, incomingState));
        }
        if (event.type === "error") {
          throw new Error(event.error ?? "Discussion failed");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discussion failed");
    } finally {
      setLoading(false);
      void refreshSession();
    }
  }

  const toolHistory = [...(state?.tool_history ?? []), ...(state?.pending_tool_results ?? [])];
  const activeRound = state?.pending_round_snapshot?.round ?? (loading ? (state?.current_round ?? 0) + 1 : null);
  const centerStatus = state?.final_decision?.result ?? (loading ? "processing" : "idle");
  const centerLabel = state?.final_decision
    ? decisionText(state.final_decision.result, t)
    : loading
      ? `${t.round} ${activeRound ?? 1}`
      : "MAGI";

  return (
    <main className="shell">
      <div className="scanlines" aria-hidden="true" />
      <section className={`workspace ${detailOpen && !detailFullscreen ? "details-open" : ""}`}>
        <aside className={`magi-console ${authSession?.authenticated ? "" : "auth-locked"}`}>
          <div className="console-header">
            <div>
              <span>{t.proposal}</span>
              <h1>MAGI System</h1>
            </div>
            <div className="console-status">
              <div className="decision-chip">
                <span>{t.decision}</span>
                <strong>{loading ? t.deliberating : decisionLabel(state?.final_decision?.result, language, t.standby)}</strong>
              </div>
              <div className="auth-chip">
                <span>{authSession?.authenticated ? t.signedIn : t.checkingAuth}</span>
                <strong>{authSession?.user?.name || authSession?.user?.email || authSession?.user?.id || "-"}</strong>
                <small>{t.quota}: {quotaRemaining ?? "-"}</small>
                {authSession?.authenticated ? (
                  <button type="button" className="chip-logout" onClick={logout} title={t.signOut}>
                    {t.signOut}
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className={`magi-stage ${loading ? "processing" : ""}`} aria-label="MAGI agent decision status">
            <div className="magi-lines" aria-hidden="true" />
            <div className={`magi-center ${centerStatus}`}>{centerLabel}</div>
            {agentOrder.map((agent) => {
              const output = outputForAgent(agent.name, state);
              const status = getAgentStatus(output, loading);
              return (
                <div className={`magi-node ${agent.slot} ${status}`} key={agent.name}>
                  <span>{agent.label}</span>
                  <strong>{statusLabel(status, output, language)}</strong>
                </div>
              );
            })}
          </div>

          <div className="query-panel">
            <label htmlFor="query">{t.query}</label>
            <textarea id="query" value={query} onChange={(event) => setQuery(event.target.value)} rows={4} placeholder={t.queryPlaceholder} />
            <div className="control-grid">
              <label className="field">
                <span>{t.language}</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value as OutputLanguage)}>
                  <option value="en">English</option>
                  <option value="zh-TW">繁體中文</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
              <label className="field">
                <span>{t.maxRounds}</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={maxRounds}
                  onChange={(event) => setMaxRounds(Number(event.target.value))}
                />
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={enableInternetSearch}
                  onChange={(event) => setEnableInternetSearch(event.target.checked)}
                />
                <span>{t.searchTool}</span>
              </label>
              <button onClick={runDiscussion} disabled={loading || !query.trim() || !canRun}>
                {loading ? t.deliberating : t.run}
              </button>
            </div>
            {!canRun && authSession?.authenticated ? <p className="error">{t.quotaEmpty}</p> : null}
            {error ? <p className="error">{error}</p> : null}
          </div>
        </aside>

        {!authSession?.authenticated ? (
          <div className="auth-overlay" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <section className="auth-window">
              <div className="auth-window-head">
                <span>MAGI System</span>
                <strong id="auth-title">{authLoading ? t.checkingAuth : t.authTitle}</strong>
              </div>
              <p>{t.authBody}</p>
              {authError ? <p className="error">{authError}</p> : null}
              <button type="button" onClick={() => { window.location.href = "/api/auth/login"; }} disabled={authLoading}>
                {authLoading ? t.checkingAuth : t.signIn}
              </button>
            </section>
          </div>
        ) : null}

        {!detailOpen ? (
          <button
            type="button"
            className="edge-toggle"
            aria-label={t.openDetails}
            title={t.openDetails}
            onClick={() => setDetailOpen(true)}
          >
            {"<"}
          </button>
        ) : null}

        {detailOpen ? (
          <section className={`detail-panel ${detailFullscreen ? "fullscreen" : ""}`}>
            <div className="detail-toolbar">
              <strong>{t.details}</strong>
              <div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={detailFullscreen ? t.docked : t.fullscreen}
                  title={detailFullscreen ? t.docked : t.fullscreen}
                  onClick={() => setDetailFullscreen((value) => !value)}
                >
                  {"<"}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t.closeDetails}
                  title={t.closeDetails}
                  onClick={() => {
                    setDetailOpen(false);
                    setDetailFullscreen(false);
                  }}
                >
                  {">"}
                </button>
              </div>
            </div>

            {state ? (
              <>
                <details className="drawer" open>
                  <summary>{t.finalDecision}</summary>
                  <div className="final">
                    <div className={`decision ${state.final_decision?.result ?? ""}`}>
                      <strong>{decisionText(state.final_decision?.result, t)}</strong>
                      <span>{methodText(state.final_decision?.method, t)}</span>
                    </div>
                    <p>{finalSummaryText(state.final_decision, t)}</p>
                    <div className="vote-strip">
                      <span>{t.yes} {state.final_decision?.vote_breakdown.yes}</span>
                      <span>{t.no} {state.final_decision?.vote_breakdown.no}</span>
                      <span>{t.errorStatus} {state.final_decision?.vote_breakdown.error}</span>
                      <span>{t.round} {state.final_decision?.round_count}</span>
                    </div>
                    {state.final_decision?.stats ? (
                      <div className="stats-grid">
                        <span>{t.mindChanges} {state.final_decision.stats.total_mind_changes}</span>
                        <span>{t.agentErrors} {state.final_decision.stats.total_errors}</span>
                      </div>
                    ) : null}
                  </div>
                </details>

                <details className="drawer">
                  <summary>{t.searchHistory}</summary>
                  <div className="rows">
                    {toolHistory.map((entry, index) => (
                      <article className="row tool-row" key={`${entry.round}-${entry.requestingAgent}-${index}`}>
                        <div className="row-head">
                          <b>{t.round} {entry.round} · {entry.request.tool}</b>
                          <span>{entry.requestingAgent}</span>
                        </div>
                        <p>{entry.request.query}</p>
                        <ul>
                          {entry.results.map((result) => (
                            <li key={result.id}>
                              <b>{result.title}</b>: {result.snippet}
                            </li>
                          ))}
                        </ul>
                      </article>
                    ))}
                  </div>
                </details>

                <details className="drawer" open>
                  <summary>{t.rounds}</summary>
                  {state.discussion_history.map((round) => (
                    <details className="round-drawer" key={round.round}>
                      <summary>{t.round} {round.round}</summary>
                      <div className="agents">
                        {round.agent_outputs.map((output) => {
                          const thinking = thinkingFor(state.thinking_log, round.round, output);
                          return (
                            <AgentDiscussion key={output.agent} output={output} thinking={thinking} labels={t} noThinking={t.noThinking} />
                          );
                        })}
                      </div>
                    </details>
                  ))}
                  {state.pending_round_snapshot && state.pending_agent_outputs && state.pending_agent_outputs.length > 0 ? (
                    <details className="round-drawer" open>
                      <summary>{t.round} {state.pending_round_snapshot.round} · {t.processing}</summary>
                      <div className="agents">
                        {state.pending_agent_outputs.map((output) => {
                          const thinking = thinkingFor(state.pending_thinking_log, state.pending_round_snapshot?.round ?? 0, output);
                          return (
                            <AgentDiscussion
                              key={output.agent}
                              output={output}
                              thinking={thinking}
                              labels={t}
                              noThinking={t.noThinking}
                            />
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                </details>
              </>
            ) : (
              <div className="empty-state">
                <h2>{t.emptyTitle}</h2>
                <p>{t.emptyBody}</p>
              </div>
            )}
          </section>
        ) : null}
      </section>
    </main>
  );
}

function thinkingFor(thinkingLog: ThinkingLog[] | undefined, round: number, output: AgentOutput): ThinkingLog[] {
  return (thinkingLog ?? []).filter((entry) => entry.round === round && entry.agent === output.agent);
}

function mergeMagiUiState(previous: MagiState | null, incoming: MagiState): MagiState {
  if (!previous) {
    return incoming;
  }

  const previousPendingRound = previous.pending_round_snapshot?.round;
  const incomingPendingRound = incoming.pending_round_snapshot?.round;
  const samePendingRound = previousPendingRound !== undefined && previousPendingRound === incomingPendingRound;
  const shouldClearPending =
    incoming.pending_round_snapshot === null
    || ((incoming.discussion_history?.length ?? 0) > (previous.discussion_history?.length ?? 0));

  return {
    ...previous,
    ...incoming,
    discussion_history: mergeRounds(previous.discussion_history, incoming.discussion_history),
    tool_history: mergeToolHistory(previous.tool_history, incoming.tool_history),
    thinking_log: mergeThinkingLog(previous.thinking_log, incoming.thinking_log),
    pending_agent_outputs: shouldClearPending
      ? incoming.pending_agent_outputs ?? []
      : samePendingRound
        ? mergeAgentOutputs(previous.pending_agent_outputs, incoming.pending_agent_outputs)
        : incoming.pending_agent_outputs ?? previous.pending_agent_outputs,
    pending_tool_results: shouldClearPending
      ? incoming.pending_tool_results ?? []
      : samePendingRound
        ? mergeToolHistory(previous.pending_tool_results, incoming.pending_tool_results)
        : incoming.pending_tool_results ?? previous.pending_tool_results,
    pending_thinking_log: shouldClearPending
      ? incoming.pending_thinking_log ?? []
      : samePendingRound
        ? mergeThinkingLog(previous.pending_thinking_log, incoming.pending_thinking_log)
        : incoming.pending_thinking_log ?? previous.pending_thinking_log
  };
}

function mergeAgentOutputs(previous: AgentOutput[] | undefined, incoming: AgentOutput[] | undefined): AgentOutput[] {
  const byAgent = new Map<AgentName, AgentOutput>();
  for (const output of previous ?? []) {
    byAgent.set(output.agent, output);
  }
  for (const output of incoming ?? []) {
    byAgent.set(output.agent, output);
  }
  return agentOrder.flatMap((agent) => {
    const output = byAgent.get(agent.name);
    return output ? [output] : [];
  });
}

function mergeRounds(previous: MagiState["discussion_history"], incoming: MagiState["discussion_history"]): MagiState["discussion_history"] {
  const byRound = new Map<number, MagiState["discussion_history"][number]>();
  for (const round of previous ?? []) {
    byRound.set(round.round, round);
  }
  for (const round of incoming ?? []) {
    byRound.set(round.round, round);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

function mergeToolHistory(
  previous: MagiState["tool_history"] | undefined,
  incoming: MagiState["tool_history"] | undefined
): MagiState["tool_history"] {
  const byEntry = new Map<string, MagiState["tool_history"][number]>();
  for (const entry of [...(previous ?? []), ...(incoming ?? [])]) {
    byEntry.set(`${entry.round}:${entry.requestingAgent}:${entry.request.tool}:${entry.request.query}`, entry);
  }
  return [...byEntry.values()].sort((a, b) => a.round - b.round);
}

function mergeThinkingLog(
  previous: ThinkingLog[] | undefined,
  incoming: ThinkingLog[] | undefined
): ThinkingLog[] {
  const byEntry = new Map<string, ThinkingLog>();
  for (const entry of [...(previous ?? []), ...(incoming ?? [])]) {
    byEntry.set(`${entry.round}:${entry.agent}:${entry.iteration}:${entry.phase}:${entry.thinking}`, entry);
  }
  return [...byEntry.values()].sort((a, b) => a.round - b.round || a.iteration - b.iteration);
}

function outputForAgent(agent: AgentName, state: MagiState | null): AgentOutput | undefined {
  const pendingOutput = state?.pending_agent_outputs?.find((output) => output.agent === agent);
  if (pendingOutput) {
    return pendingOutput;
  }

  for (const round of [...(state?.discussion_history ?? [])].reverse()) {
    const historicalOutput = round.agent_outputs.find((output) => output.agent === agent);
    if (historicalOutput) {
      return historicalOutput;
    }
  }

  return undefined;
}

function readStoredSettings(): { language: OutputLanguage; maxRounds: number; enableInternetSearch: boolean } | null {
  try {
    const raw = localStorage.getItem(settingsStorageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<{
      language: unknown;
      maxRounds: unknown;
      enableInternetSearch: unknown;
    }>;
    return {
      language: isOutputLanguage(parsed.language) ? parsed.language : "en",
      maxRounds: normalizeMaxRounds(parsed.maxRounds),
      enableInternetSearch: typeof parsed.enableInternetSearch === "boolean" ? parsed.enableInternetSearch : false
    };
  } catch {
    return null;
  }
}

function isOutputLanguage(value: unknown): value is OutputLanguage {
  return value === "en" || value === "zh-TW" || value === "ja";
}

function normalizeMaxRounds(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return 3;
  }

  return Math.min(5, Math.max(1, Math.floor(numericValue)));
}

function AgentDiscussion({
  output,
  thinking,
  labels,
  noThinking
}: {
  output: AgentOutput;
  thinking: ThinkingLog[];
  labels: Record<string, string>;
  noThinking: string;
}) {
  return (
    <article className={`agent ${getAgentStatus(output, false)}`}>
      <div className="agent-head">
        <b>{output.agent}</b>
        <span>{decisionText(output.decision, labels)} · {Math.round(output.confidence * 100)}%</span>
      </div>
      <p>{output.shared_explanation}</p>
      <p>
        <b>{labels.persuasion}:</b> {output.persuasion_message}
      </p>
      <p>
        <b>{labels.changeMind}:</b> {output.what_would_change_my_mind}
      </p>
      <details className="tool-entry">
        <summary>{labels.toolUse}</summary>
        {output.tool_results && output.tool_results.length > 0 ? (
          output.tool_results.map((entry, index) => (
            <div className="tool-detail" key={`${entry.round}-${entry.requestingAgent}-${index}`}>
              <div className="row-head">
                <b>{entry.request.tool}</b>
                <span>{labels.caller}: {entry.requestingAgent}</span>
              </div>
              <p>{entry.request.query}</p>
              <ul>
                {entry.results.map((result) => (
                  <li key={result.id}>
                    <b>{result.title}</b>: {result.snippet}
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : output.tool_requests.length > 0 ? (
          <div className="tool-detail">
            {output.tool_requests.map((request, index) => (
              <p key={`${request.tool}-${index}`}>
                <b>{request.tool}:</b> {request.query}
              </p>
            ))}
          </div>
        ) : (
          <pre>{labels.results}: 0</pre>
        )}
      </details>
      <details className="thinking-entry">
        <summary>{labels.thinking}</summary>
        {thinking.length > 0 ? (
          thinking.map((entry) => <pre key={`${entry.iteration}-${entry.phase}`}>{entry.thinking || noThinking}</pre>)
        ) : (
          <pre>{output.raw_thinking || noThinking}</pre>
        )}
      </details>
    </article>
  );
}

function getAgentStatus(output: AgentOutput | undefined, loading: boolean): "idle" | "processing" | "tool" | "yes" | "no" | "error" {
  if (!output) {
    return loading ? "processing" : "idle";
  }

  if (output.decision === "error") {
    return "error";
  }

  if (output.decision === "yes" || output.decision === "no") {
    return output.decision;
  }

  if (output.tool_requests.length > 0) {
    return "tool";
  }

  return "idle";
}

function statusLabel(status: ReturnType<typeof getAgentStatus>, output: AgentOutput | undefined, language: OutputLanguage): string {
  if (status === "processing") {
    return language === "en" ? "PROCESSING" : language === "ja" ? "処理中" : "處理中";
  }

  if (status === "tool") {
    return "TOOL";
  }

  if (status === "error") {
    return "ERROR";
  }

  if (status === "yes") {
    const yes = language === "en" ? "YES" : "承認";
    return `${yes} ${Math.round((output?.confidence ?? 0) * 100)}%`;
  }

  if (status === "no") {
    const no = language === "en" ? "NO" : "否定";
    return `${no} ${Math.round((output?.confidence ?? 0) * 100)}%`;
  }

  return language === "en" ? "STANDBY" : language === "ja" ? "待機" : "待機";
}

function decisionLabel(result: "yes" | "no" | "error" | undefined, language: OutputLanguage, fallback: string): string {
  if (!result) {
    return fallback;
  }

  if (result === "yes") {
    return language === "en" ? "YES" : "承認";
  }

  if (result === "error") {
    return "ERROR";
  }

  return language === "en" ? "NO" : "否定";
}

function decisionText(result: "yes" | "no" | "error" | undefined, labels: Record<string, string>): string {
  if (result === "yes") {
    return labels.yes;
  }

  if (result === "no") {
    return labels.no;
  }

  if (result === "error") {
    return labels.errorStatus;
  }

  return "";
}

function methodText(method: "consensus" | "majority_vote" | "stable_vote" | "error" | undefined, labels: Record<string, string>): string {
  if (method === "consensus") {
    return labels.methodConsensus;
  }

  if (method === "majority_vote") {
    return labels.methodMajorityVote;
  }

  if (method === "stable_vote") {
    return labels.methodStableVote;
  }

  if (method === "error") {
    return labels.methodError;
  }

  return "";
}

function finalSummaryText(finalDecision: MagiState["final_decision"], labels: Record<string, string>): string {
  if (!finalDecision) {
    return "";
  }

  const result = decisionText(finalDecision.result, labels);
  const template =
    finalDecision.method === "consensus"
      ? labels.summaryConsensus
      : finalDecision.method === "majority_vote"
        ? labels.summaryMajorityVote
        : finalDecision.method === "stable_vote"
          ? labels.summaryStableVote
          : labels.summaryError;

  return template
    .replace("{rounds}", String(finalDecision.round_count))
    .replace("{result}", result);
}
