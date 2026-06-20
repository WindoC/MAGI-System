import { NextResponse } from "next/server";
import { getQuotaForSession, readSession } from "../../../../src/magi/auth";

export async function GET(request: Request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const quota = await getQuotaForSession(session);
  return NextResponse.json({ quota });
}
