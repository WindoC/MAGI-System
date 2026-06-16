import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DiscussionRepository } from "../src/magi/storage";
import type { MagiState } from "../src/magi/types";

describe("DiscussionRepository", () => {
  it("saves and reloads a discussion state", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "magi-")), "test.sqlite");
    const repository = new DiscussionRepository(dbPath);
    const state: MagiState = {
      query: "test query",
      current_round: 1,
      max_rounds: 1,
      search_before_discuss: [],
      shared_search_pool: [],
      discussion_history: [],
      tool_history: [],
      user_audit_log: [],
      final_decision: {
        result: "yes",
        method: "consensus",
        round_count: 1,
        vote_breakdown: { yes: 3, no: 0, error: 0 },
        stats: {
          mind_changes: { melchior: 0, balthasar: 0, casper: 0 },
          agent_errors: { melchior: 0, balthasar: 0, casper: 0 },
          total_mind_changes: 0,
          total_errors: 0
        },
        final_summary: "done"
      }
    };

    const saved = repository.save(state);

    expect(saved.id).toBeTruthy();
    expect(repository.get(saved.id!)).toMatchObject({ query: "test query", final_decision: { result: "yes" } });
    expect(repository.list()).toHaveLength(1);
  });
});
