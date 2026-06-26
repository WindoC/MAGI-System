import { NextResponse } from "next/server";
import { completeOAuthCallback, createPostAuthRedirectUrl } from "../../../../src/magi/auth";

export async function GET(request: Request) {
  try {
    const result = await completeOAuthCallback(request);
    if (!result.ok) {
      const response = NextResponse.json({ error: result.error }, { status: result.status });
      for (const cookie of result.setCookie ?? []) {
        response.headers.append("Set-Cookie", cookie);
      }
      return response;
    }

    const response = NextResponse.redirect(createPostAuthRedirectUrl(result.redirectUrl, request));
    for (const cookie of result.setCookie) {
      response.headers.append("Set-Cookie", cookie);
    }
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: "oauth callback failed",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
