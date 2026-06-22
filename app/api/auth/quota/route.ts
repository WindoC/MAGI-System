import { NextResponse } from "next/server";
import { createSessionCookie, getQuotaForSession, readSession } from "../../../../src/magi/auth";

export async function GET(request: Request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const quota = await getQuotaForSession(session);
  const response = NextResponse.json({ quota });
  if (quota.remaining !== null) {
    response.headers.append("Set-Cookie", createSessionCookie({ ...session, quotaRemaining: quota.remaining }, request));
  }
  return response;
}
