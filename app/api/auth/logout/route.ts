import { NextResponse } from "next/server";
import { clearSessionCookie } from "../../../../src/magi/auth";

export async function POST(request: Request) {
  const response = NextResponse.json({ ok: true });
  response.headers.append("Set-Cookie", clearSessionCookie(request));
  return response;
}
