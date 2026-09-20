/* Accounts, balances and the ledger.
 *
 * Balances are play money, but they are kept the way real ones have to be:
 * integer cents, changed only through an append-only ledger, inside a
 * transaction. The stored balance is a cache of the ledger, never the other
 * way round, and a test asserts the two agree for every account.
 *
 * The reason to do it properly now is that this is the part you cannot
 * retrofit. Swapping play money for real money later is a change of what the
 * numbers mean; a ledger that was never trustworthy is a rewrite.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;
/** What a new account starts with, in cents. Play money, so it is a gift. */
export const STARTING_BALANCE = 100000; // $1,000.00

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      display     TEXT NOT NULL,
      pass_hash   BLOB NOT NULL,
      pass_salt   BLOB NOT NULL,
      balance     INTEGER NOT NULL DEFAULT 0,   -- cents; cache of the ledger
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- Append-only. Nothing in here is ever updated or deleted; a correction is
    -- another entry. The balance of an account is the sum of its rows.
    CREATE TABLE IF NOT EXISTS ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL REFERENCES users(id),
      delta      INTEGER NOT NULL,              -- cents, signed
      reason     TEXT NOT NULL,                 -- 'signup' | 'bet' | 'settle' | ...
      ref        TEXT,                          -- hand id, table id, whatever explains it
      balance_after INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  `);
  return db;
}

const now = () => Date.now();

function hashPassword(password, salt = randomBytes(16)) {
  return { hash: scryptSync(password, salt, SCRYPT.keylen, SCRYPT), salt };
}

export class Accounts {
  constructor(db) { this.db = db; }

  /* ------------------------------------------------------------- accounts */
  createUser(email, password, display) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('that does not look like an email address');
    if (String(password || '').length < 8) throw new Error('password must be at least 8 characters');
    display = String(display || email.split('@')[0]).slice(0, 24);

    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) throw new Error('an account with that email already exists');

    const { hash, salt } = hashPassword(password);
    const id = randomUUID();
    const t = now();

    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        'INSERT INTO users (id,email,display,pass_hash,pass_salt,balance,created_at) VALUES (?,?,?,?,?,0,?)'
      ).run(id, email, display, hash, salt, t);
      this.#post(id, STARTING_BALANCE, 'signup', null);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getUser(id);
  }

  verifyPassword(email, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?')
      .get(String(email || '').trim().toLowerCase());
    if (!row) return null;
    const { hash } = hashPassword(password, row.pass_salt);
    // Constant time: a length mismatch would otherwise leak through timing.
    if (hash.length !== row.pass_hash.length) return null;
    if (!timingSafeEqual(hash, Buffer.from(row.pass_hash))) return null;
    return this.getUser(row.id);
  }

  getUser(id) {
    const r = this.db.prepare('SELECT id,email,display,balance,created_at FROM users WHERE id = ?').get(id);
    return r || null;
  }

  /* ------------------------------------------------------------- sessions */
  startSession(userId) {
    const token = randomBytes(32).toString('hex');
    const t = now();
    this.db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(token, userId, t, t + SESSION_DAYS * 864e5);
    return token;
  }

  userForSession(token) {
    if (!token) return null;
    const s = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s) return null;
    if (s.expires_at < now()) { this.endSession(token); return null; }
    return this.getUser(s.user_id);
  }

  endSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /* --------------------------------------------------------------- money */
  /** Write one ledger entry and move the cached balance with it. */
  #post(userId, delta, reason, ref) {
    const row = this.db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    if (!row) throw new Error('no such account');
    const after = row.balance + delta;
    if (after < 0) throw new Error('insufficient funds');
    this.db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(after, userId);
    this.db.prepare(
      'INSERT INTO ledger (user_id,delta,reason,ref,balance_after,created_at) VALUES (?,?,?,?,?,?)'
    ).run(userId, delta, reason, ref ?? null, after, now());
    return after;
  }

  /**
   * Apply a set of balance changes atomically. A hand settles several seats at
   * once and either all of it lands or none of it does — a crash halfway
   * through must not pay one player and forget another.
   */
  post(entries) {
    this.db.exec('BEGIN');
    try {
      const out = entries.map(e => ({ userId: e.userId, balance: this.#post(e.userId, e.delta, e.reason, e.ref) }));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  balance(userId) {
    const r = this.db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    return r ? r.balance : 0;
  }

  history(userId, limit = 50) {
    return this.db.prepare(
      'SELECT delta,reason,ref,balance_after,created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?'
    ).all(userId, limit);
  }

  /**
   * Does every cached balance equal the sum of that account's ledger?
   * Returns the accounts where it does not, which should always be none.
   */
  audit() {
    return this.db.prepare(`
      SELECT u.id, u.balance, COALESCE(SUM(l.delta), 0) AS ledger_total
      FROM users u LEFT JOIN ledger l ON l.user_id = u.id
      GROUP BY u.id
      HAVING u.balance != COALESCE(SUM(l.delta), 0)
    `).all();
  }
}
