import { NextResponse } from "next/server";
import { debitQuotaForSession, readSession } from "../../../../src/magi/auth";
import { MagiEngine } from "../../../../src/magi/engine";
import { getDiscussionRepository } from "../../../../src/magi/storage";
import type { MagiStreamEvent, OutputLanguage } from "../../../../src/magi/types";

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
  const debit = await debitQuotaForSession(request, session, 1);
  if (!debit.ok) {
    return NextResponse.json({ error: debit.error, quota: debit.quota }, { status: debit.status });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: MagiStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void (async () => {
        try {
          const engine = new MagiEngine();
          const repository = getDiscussionRepository();
          const state = await engine.run({
            query,
            maxRounds,
            enableInternetSearch,
            language,
            onUpdate: send
          });
          const saved = repository.save(state);
          send({ type: "done", node: "saved", state: saved });
        } catch (error) {
          console.error("[MAGI API] streamed discussion failed", error);
          send({
            type: "error",
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          controller.close();
        }
      })();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...(debit.setCookie ? { "Set-Cookie": debit.setCookie } : {})
    }
  });
}

function normalizeLanguage(language: unknown): OutputLanguage {
  return language === "zh-TW" || language === "ja" || language === "en" ? language : "en";
}
