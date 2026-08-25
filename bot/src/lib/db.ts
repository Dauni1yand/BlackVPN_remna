import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Just enough local state for what's implemented so far: one row per
// Telegram user tracking whether they've used their trial subscription.
// Deliberately not modeling anything Remnawave already owns (users,
// traffic, expiry) — the panel stays the source of truth for that; this
// table only answers "has this Telegram user already gotten a trial".

export interface TrialGrantRow {
  telegram_id: number;
  status: 'pending' | 'active';
  remnawave_username: string | null;
  remnawave_user_id: number | null;
  subscription_url: string | null;
  created_at: string;
  expires_at: string | null;
}

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trial_grants (
      telegram_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      remnawave_username TEXT,
      remnawave_user_id INTEGER,
      subscription_url TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
  `);
  return db;
}

// Atomically claims a trial slot for telegramId: returns true only for the
// caller that actually inserted the row, so a double tap on the trial
// button (or a retry) can't grant two trials. Safe without extra locking
// because better-sqlite3 is synchronous and Node is single-threaded — no
// other handler can run between the check and the insert.
export function reserveTrialSlot(db: Database.Database, telegramId: number): boolean {
  const info = db
    .prepare('INSERT OR IGNORE INTO trial_grants (telegram_id, status, created_at) VALUES (?, ?, ?)')
    .run(telegramId, 'pending', new Date().toISOString());
  return info.changes === 1;
}

export function commitTrialSlot(
  db: Database.Database,
  telegramId: number,
  data: { username: string; userId: number; subscriptionUrl: string; expiresAt: string },
): void {
  db.prepare(
    `UPDATE trial_grants
     SET status = 'active', remnawave_username = ?, remnawave_user_id = ?, subscription_url = ?, expires_at = ?
     WHERE telegram_id = ?`,
  ).run(data.username, data.userId, data.subscriptionUrl, data.expiresAt, telegramId);
}

// Rolls back a reservation that failed to turn into an actual Remnawave
// user (e.g. the panel was unreachable), so the Telegram user can retry.
export function releaseTrialSlot(db: Database.Database, telegramId: number): void {
  db.prepare(`DELETE FROM trial_grants WHERE telegram_id = ? AND status = 'pending'`).run(telegramId);
}

export function getTrialGrant(db: Database.Database, telegramId: number): TrialGrantRow | undefined {
  return db.prepare('SELECT * FROM trial_grants WHERE telegram_id = ?').get(telegramId) as
    | TrialGrantRow
    | undefined;
}
