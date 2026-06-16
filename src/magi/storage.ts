import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MagiState } from "./types";

export class DiscussionRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(process.cwd(), "data", "magi.sqlite")) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discussions (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      )
    `);
  }

  save(state: MagiState): MagiState {
    const id = state.id ?? crypto.randomUUID();
    const saved = { ...state, id };
    const statement = this.db.prepare(`
      INSERT INTO discussions (id, query, created_at, state_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        query = excluded.query,
        state_json = excluded.state_json
    `);

    statement.run(id, state.query, new Date().toISOString(), JSON.stringify(saved));
    return saved;
  }

  get(id: string): MagiState | null {
    const statement = this.db.prepare("SELECT state_json FROM discussions WHERE id = ?");
    const row = statement.get(id) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as MagiState) : null;
  }

  list(): Array<{ id: string; query: string; created_at: string }> {
    const statement = this.db.prepare("SELECT id, query, created_at FROM discussions ORDER BY created_at DESC LIMIT 50");
    return statement.all() as Array<{ id: string; query: string; created_at: string }>;
  }
}

export function getDiscussionRepository(): DiscussionRepository {
  return new DiscussionRepository();
}
