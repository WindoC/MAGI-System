import { NextResponse } from "next/server";
import { getDiscussionRepository } from "../../../../src/magi/storage";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const repository = getDiscussionRepository();
  const state = repository.get(id);

  if (!state) {
    return NextResponse.json({ error: "discussion not found" }, { status: 404 });
  }

  return NextResponse.json(state);
}
