import { NextResponse } from "next/server";
import { createOAuthLogin } from "../../../../src/magi/auth";

export async function GET(request: Request) {
  try {
    const login = createOAuthLogin(request);
    const response = NextResponse.redirect(login.redirectUrl);
    response.headers.append("Set-Cookie", login.setCookie);
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: "oauth login unavailable",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
