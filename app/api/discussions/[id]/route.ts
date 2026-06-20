import { NextResponse } from "next/server";
import { readSession } from "../../../../src/magi/auth";
import { getDiscussionRepository } from "../../../../src/magi/storage";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = readSession(request);
  if (!session) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const { id } = await context.params;
  const repository = getDiscussionRepository();
  const state = repository.get(id);

  if (!state) {
    return NextResponse.json({ error: "discussion not found" }, { status: 404 });
  }

  return NextResponse.json(state);
}
