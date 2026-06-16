import crypto from "node:crypto";
import type { AgentName, SearchAdapter, SearchResult } from "./types";

type FetchLike = typeof fetch;

export class InternalSearchAdapter implements SearchAdapter {
  private readonly corpus: Array<{ title: string; snippet: string; source: string }>;

  constructor(corpus?: Array<{ title: string; snippet: string; source: string }>) {
    this.corpus = corpus ?? [
      {
        title: "MAGI operating principle",
        snippet:
          "The MVP is a read-only deliberation system. It exposes synchronized rounds, transparent search records, and final consensus or majority decisions.",
        source: "local://prd/core"
      },
      {
        title: "Read-only tool policy",
        snippet:
          "Tools may retrieve information for discussion but must not execute commands, write files, call write APIs, or change external environments.",
        source: "local://prd/tools"
      },
      {
        title: "Consensus rule",
        snippet:
          "Consensus is reached only when all three agents vote yes or all three agents vote no. Otherwise, max-round termination uses majority vote.",
        source: "local://prd/consensus"
      },
      {
        title: "Agent isolation rule",
        snippet:
          "Agents evaluate immutable snapshots and cannot observe current-round outputs, search requests, search results, or confidence from other agents.",
        source: "local://prd/isolation"
      }
    ];
  }

  async search(query: string, requestedBy: AgentName | "system", round: number): Promise<SearchResult[]> {
    const terms = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    const ranked = this.corpus
      .map((entry) => ({
        entry,
        score: [...terms].filter((term) => `${entry.title} ${entry.snippet}`.toLowerCase().includes(term)).length
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const selected = ranked.some((item) => item.score > 0) ? ranked : ranked.slice(0, 2);
    return selected.map(({ entry }, index) => ({
      id: crypto.createHash("sha256").update(`${round}:${requestedBy}:${query}:${entry.source}:${index}`).digest("hex").slice(0, 16),
      query,
      title: entry.title,
      snippet: entry.snippet,
      source: entry.source,
      requestedBy,
      round
    }));
  }
}

export class InternetSearchAdapter implements SearchAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly maxResults: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { fetchImpl?: FetchLike; maxResults?: number; apiKey?: string; baseUrl?: string; model?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxResults = options.maxResults ?? Number(process.env.OPENROUTER_SEARCH_MAX_RESULTS ?? 5);
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    this.baseUrl = options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    this.model = options.model ?? process.env.OPENROUTER_SEARCH_MODEL ?? "perplexity/sonar-pro-search";
  }

  async search(query: string, requestedBy: AgentName | "system", round: number): Promise<SearchResult[]> {
    if (!this.apiKey) {
      console.warn("[MAGI search] OPENROUTER_API_KEY is not set; returning empty search results", {
        query,
        requestedBy,
        round
      });
      return [];
    }

    try {
      return await this.searchOpenRouter(query, requestedBy, round);
    } catch (error) {
      console.warn("[MAGI search] OpenRouter internet search failed; returning empty search results", {
        query,
        requestedBy,
        round,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private async searchOpenRouter(query: string, requestedBy: AgentName | "system", round: number): Promise<SearchResult[]> {
    const payload = {
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "You are a read-only internet search assistant. Search the web, summarize only information relevant to the query, and cite sources."
        },
        { role: "user", content: query }
      ],
      reasoning: { enabled: true },
      plugins: [
        {
          id: "web",
          max_results: this.maxResults
        }
      ]
    };

    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_NAME ?? "MAGI-System"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`OpenRouter search failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const responsePayload = await response.json() as { model?: string; choices?: Array<{ message?: OpenRouterSearchMessage }> };
    const message = responsePayload.choices?.[0]?.message;
    if (!message) {
      return [];
    }

    return parseOpenRouterSearchMessage(message, query, requestedBy, round, this.maxResults, responsePayload.model ?? this.model);
  }
}

type OpenRouterSearchMessage = {
  content?: string;
  annotations?: Array<{
    type?: string;
    url_citation?: {
      title?: string;
      url?: string;
      content?: string;
    };
  }>;
};

export function parseOpenRouterSearchMessage(
  message: OpenRouterSearchMessage,
  query: string,
  requestedBy: AgentName | "system",
  round: number,
  maxResults = 5,
  model = "perplexity/sonar-pro-search"
): SearchResult[] {
  const citations = message.annotations?.filter((annotation) => annotation.type === "url_citation") ?? [];
  return citations.slice(0, maxResults).map((annotation, index) => {
    const citation = annotation.url_citation ?? {};
    const source = citation.url ?? `${model}:citation:${index}`;
    return {
      id: crypto.createHash("sha256").update(`${round}:${requestedBy}:${query}:${source}:${index}`).digest("hex").slice(0, 16),
      query,
      title: citation.title || source,
      snippet: citation.content || message.content || source,
      source,
      requestedBy,
      round
    };
  });
}
