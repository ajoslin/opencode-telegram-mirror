/**
 * Simple state persistence for Telegram bot
 */

import { Database } from "bun:sqlite"
import type { LogFn } from "./log"

const DB_PATH = "/tmp/telegram-opencode.db"

let db: Database | null = null

export function getDb(log: LogFn): Database {
  if (!db) {
    log("debug", "Opening SQLite database", { path: DB_PATH })
    db = new Database(DB_PATH, { create: true })

    db.run(
      "CREATE TABLE IF NOT EXISTS state (" +
        "key TEXT PRIMARY KEY, " +
        "value TEXT NOT NULL)"
    )

    log("info", "SQLite database initialized", { path: DB_PATH })
  }
  return db
}

/**
 * Get the stored session ID
 */
export function getSessionId(log: LogFn): string | null {
  const database = getDb(log)
  type Row = { value: string }
  const row = database
    .query<Row, [string]>("SELECT value FROM state WHERE key = ?")
    .get("session_id")
  return row?.value ?? null
}

/**
 * Store the session ID
 */
export function setSessionId(sessionId: string, log: LogFn): void {
  const database = getDb(log)
  database.run(
    "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
    ["session_id", sessionId]
  )
  log("info", "Stored session ID", { sessionId })
}

/**
 * Get the last processed Telegram update_id
 */
export function getLastUpdateId(log: LogFn): number {
  const database = getDb(log)
  type Row = { value: string }
  const row = database
    .query<Row, [string]>("SELECT value FROM state WHERE key = ?")
    .get("last_update_id")
  return row ? Number.parseInt(row.value, 10) : 0
}

/**
 * Store the last processed Telegram update_id
 */
export function setLastUpdateId(updateId: number, log: LogFn): void {
  const database = getDb(log)
  database.run(
    "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
    ["last_update_id", String(updateId)]
  )
}
