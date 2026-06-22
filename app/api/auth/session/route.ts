import { NextResponse } from "next/server";
import { publicSession, readSession } from "../../../../src/magi/auth";

export async function GET(request: Request) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json(publicSession(null));
  }

  return NextResponse.json(publicSession(session));
}
