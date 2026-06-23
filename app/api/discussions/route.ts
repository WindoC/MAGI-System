import { NextResponse } from "next/server";
import { checkQuotaForSession, consumeQuotaForSession, readSession } from "../../../src/magi/auth";
import { MagiEngine } from "../../../src/magi/engine";
import { getDiscussionRepository } from "../../../src/magi/storage";
import type { OutputLanguage } from "../../../src/magi/types";

export async function GET(request: Request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const repository = getDiscussionRepository();
  return NextResponse.json({ discussions: repository.list() });
}

export async function POST(request: Request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const body = (await request.json()) as {
    query?: string;
    maxRounds?: number;
    enableInternetSearch?: boolean;
    language?: OutputLanguage;
  };
  const query = body.query?.trim();

  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const maxRounds = Math.min(Math.max(body.maxRounds ?? 3, 1), 5);
  const language = normalizeLanguage(body.language);
  const enableInternetSearch = body.enableInternetSearch === true;
  const quotaCheck = await checkQuotaForSession(request, session, 1);
  if (!quotaCheck.ok) {
    return NextResponse.json({ error: quotaCheck.error, quota: quotaCheck.quota }, { status: quotaCheck.status });
  }

  try {
    const engine = new MagiEngine();
    const repository = getDiscussionRepository();
    const state = await engine.run({ query, maxRounds, enableInternetSearch, language });
    const saved = repository.save(state);
    const quotaConsume = await consumeQuotaForSession(request, session, 1, quotaCheck.requestId!);
    if (!quotaConsume.ok) {
      return NextResponse.json({ error: quotaConsume.error, quota: quotaConsume.quota }, { status: quotaConsume.status });
    }

    const response = NextResponse.json(saved);
    if (quotaConsume.setCookie) {
      response.headers.append("Set-Cookie", quotaConsume.setCookie);
    }
    return response;
  } catch (error) {
    console.error("[MAGI API] discussion failed", error);
    return NextResponse.json(
      {
        error: "discussion failed",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

function normalizeLanguage(language: unknown): OutputLanguage {
  return language === "zh-TW" || language === "ja" || language === "en" ? language : "en";
}
