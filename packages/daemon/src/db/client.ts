import Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { getDbPath } from "../config.js";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logging.js";

const logger = createLogger("db-client");

export function createDatabase(config: AgentConfig): Database.Database {
  const dbPath = getDbPath(config);

  // Ensure data directory exists with restricted permissions
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);

  // Restrict DB file permissions to owner-only (rw-------)
  try {
    const st = statSync(dbPath);
    if ((st.mode & 0o077) !== 0) {
      chmodSync(dbPath, 0o600);
    }
  } catch { /* ignore — stat can fail on in-memory DBs */ }

  // Enable WAL mode for concurrent reads/writes
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Synchronous NORMAL is safe with WAL and faster than FULL
  db.pragma("synchronous = NORMAL");

  // Quick structural integrity check — catches B-tree corruption without
  // the full-table scan cost of integrity_check. Log and continue rather
  // than throwing so the daemon can still attempt to operate.
  try {
    const rows = db.pragma("quick_check") as { quick_check: string }[];
    const ok = rows.length === 1 && rows[0].quick_check === "ok";
    if (!ok) {
      const issues = rows.map((r) => r.quick_check).join("; ");
      logger.error(
        { issues },
        "Database quick_check failed — data may be corrupted. See docs/troubleshooting.md",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to run database quick_check");
  }

  return db;
}

/** Create an in-memory database for testing */
export function createTestDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}
