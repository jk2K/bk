import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
export class State {
  db: DatabaseSync;
  constructor(root: string) {
    mkdirSync(join(root, ".bk"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, ".bk/state.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO schema_migrations VALUES(1);
  CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision TEXT, due INTEGER NOT NULL DEFAULT 0, status TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, change_id TEXT UNIQUE NOT NULL, base TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, report TEXT NOT NULL, remote TEXT);
  CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, kind TEXT NOT NULL, payload TEXT NOT NULL);`);
    this.transaction(() => {
      if (
        !(this.db.prepare("PRAGMA table_info(sources)").all() as any[]).some(
          (c) => c.name === "attempts",
        )
      )
        this.db.exec(
          "ALTER TABLE sources ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0; INSERT OR IGNORE INTO schema_migrations VALUES(2);",
        );
      if (
        !(this.db.prepare("PRAGMA table_info(changes)").all() as any[]).some(
          (c) => c.name === "analysis_key",
        )
      )
        this.db.exec(
          "ALTER TABLE changes ADD COLUMN analysis_key TEXT; INSERT OR IGNORE INTO schema_migrations VALUES(3);",
        );
    });
    // The repository lock guarantees there is no live owner when opening a write pipeline.
  }
  recover() {
    this.db.exec("UPDATE changes SET status='queued' WHERE status='analyzing'");
  }
  transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  getSource(id: string): any {
    return this.db.prepare("SELECT * FROM sources WHERE id=?").get(id);
  }
  event(kind: string, payload: unknown) {
    this.db
      .prepare("INSERT INTO history(kind,payload) VALUES(?,?)")
      .run(kind, JSON.stringify(payload));
  }
  pending(source?: string): any[] {
    return this.db
      .prepare(
        "SELECT * FROM changes WHERE status IN ('queued','retry') AND retry_at<=?" +
          (source ? " AND source_id=?" : "") +
          " ORDER BY rowid",
      )
      .all(...(source ? [Date.now(), source] : [Date.now()]));
  }
  close() {
    this.db.close();
  }
}
