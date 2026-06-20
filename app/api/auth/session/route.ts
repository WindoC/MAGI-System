import { NextResponse } from "next/server";
import { getQuotaForSession, publicSession, readSession } from "../../../../src/magi/auth";

export async function GET(request: Request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json(publicSession(null));
  }

  const quota = await getQuotaForSession(session);
  return NextResponse.json({
    ...publicSession({ ...session, quotaRemaining: quota.remaining }),
    quota
  });
}
