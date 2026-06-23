import { NextResponse } from "next/server";
import { debitQuotaForSession, readSession } from "../../../../../src/magi/auth";

export async function POST(request: Request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { amount?: number };
  const amount = normalizeAmount(body.amount);
  const debit = await debitQuotaForSession(request, session, amount);
  if (!debit.ok) {
    return NextResponse.json({ error: debit.error, quota: debit.quota }, { status: debit.status });
  }

  const response = NextResponse.json({ quota: debit.quota });
  if (debit.setCookie) {
    response.headers.append("Set-Cookie", debit.setCookie);
  }
  return response;
}

function normalizeAmount(amount: unknown): number {
  const numeric = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 1;
  }
  return Math.floor(numeric);
}
