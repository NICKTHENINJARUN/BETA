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

/* Gifting exists so people can stake a friend, not so one person can run a
   hundred signups into a single balance. Every new account arrives holding
   STARTING_BALANCE, which is exactly what makes that worth doing — so a
   giver has to have actually played first, and there is a ceiling on a day. */
export const GIFT = {
  minHandsPlayed: 50,        // roughly one sitting
  perDayCents: 50000,        // $500 out per day, however many recipients
  minCents: 100,             // $1
  maxCents: 25000,           // $250 in one go
};

/* Busting out should not end the evening, but a refill on a short timer is
   just an infinite balance with extra clicks — and it would make the gifting
   guard pointless, since there would be nothing scarce to guard. So: a grant
   only when you genuinely cannot play, and only once a day.

   $500 against a $1,000 start is deliberately generous — the point is to get
   someone back to the table, not to ration them. What stops it mattering is
   the once-a-day, and that it can never buy a place on the leaderboard, which
   ranks winnings rather than balance. */
export const BAILOUT = {
  below: 2000,             // $20 — too little to play a table with a $500 max
  grant: 50000,            // $500
  everyMs: 24 * 3600 * 1000,
};

/* Unambiguous when read aloud or typed: no O/0, no I/1/L. */
const TAG_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const TAG_LENGTH = 6;

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

    -- How far a table has been settled. This cannot be derived from the ledger:
    -- a losing hand returns nothing and so writes no row at all, which makes
    -- "a stake with no payout" indistinguishable from "a stake still on the
    -- table". This column is the difference between the two.
    CREATE TABLE IF NOT EXISTS table_state (
      id           TEXT PRIMARY KEY,
      settled_upto INTEGER NOT NULL DEFAULT 0
    );

    /* Chat is kept rather than only broadcast, for two reasons: someone
       arriving mid-shoe should see what was just said, and a report is
       meaningless if the thing reported is already gone. Removing a message
       sets its hidden flag rather than deleting the row, so a report still
       points at something and the text cannot be quietly rewritten. */
    CREATE TABLE IF NOT EXISTS chat (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL REFERENCES users(id),
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      hidden     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chat_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER NOT NULL REFERENCES chat(id),
      reporter_id TEXT NOT NULL REFERENCES users(id),
      created_at  INTEGER NOT NULL,
      UNIQUE(message_id, reporter_id)      -- one report each, not a brigade
    );

    CREATE INDEX IF NOT EXISTS chat_recent ON chat(id DESC);
    CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(ref);
    CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  `);
  /* The tag arrived after the first accounts did, so it is added rather than
     declared, and only when it is missing. A UNIQUE index rather than a column
     constraint, because SQLite cannot add one of those to a table that exists.
     Backfilled below so no account is left without a way to be paid. */
  const hasTag = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('users') WHERE name = 'tag'").get().n;
  if (!hasTag) db.exec('ALTER TABLE users ADD COLUMN tag TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_tag ON users(tag) WHERE tag IS NOT NULL');

  const untagged = db.prepare('SELECT id FROM users WHERE tag IS NULL').all();
  for (const u of untagged) {
    for (let i = 0; i < 50; i++) {
      const tag = randomTag();
      try { db.prepare('UPDATE users SET tag = ? WHERE id = ?').run(tag, u.id); break; }
      catch (e) { if (i === 49) throw e; }        // collision: draw again
    }
  }

  return db;
}

/* A rule the caller broke, not a fault in the server. Marked rather than
   left to be recognised by reading the sentence: the HTTP layer classifies
   older throws with a regex over the message, which quietly returns 500 the
   first time someone writes a refusal in words it does not happen to list. */
function refuse(message) {
  const e = new Error(message);
  e.expected = true;
  return e;
}

function randomTag() {
  const bytes = randomBytes(TAG_LENGTH);
  let out = '';
  for (let i = 0; i < TAG_LENGTH; i++) out += TAG_ALPHABET[bytes[i] % TAG_ALPHABET.length];
  return out;
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
      // Retry on the unique index rather than checking first: two signups in
      // the same moment can both pass a check and only one can pass the index.
      let inserted = false;
      for (let i = 0; i < 50 && !inserted; i++) {
        try {
          this.db.prepare(
            'INSERT INTO users (id,email,display,tag,pass_hash,pass_salt,balance,created_at) VALUES (?,?,?,?,?,?,0,?)'
          ).run(id, email, display, randomTag(), hash, salt, t);
          inserted = true;
        } catch (e) {
          if (!/users_tag/.test(String(e && e.message))) throw e;
        }
      }
      if (!inserted) throw new Error('could not allocate a player tag');
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
    const r = this.db.prepare('SELECT id,email,display,tag,balance,created_at FROM users WHERE id = ?').get(id);
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

  /* ------------------------------------------------- surviving a restart
     A hand lives in the server's memory, but its stake has already left the
     player's balance. If the process dies in between — a deploy, a crash, a
     host moving underneath it — that money is in the ledger with nothing to
     answer it, and no amount of auditing will notice, because the books
     balance perfectly. It is simply gone.

     These three are what let the next boot find it and give it back.        */

  /* --------------------------------------------------------- busting out */

  /** When this account last took a grant, or 0. */
  lastBailout(userId) {
    const r = this.db.prepare(
      "SELECT MAX(created_at) AS t FROM ledger WHERE user_id = ? AND reason = 'bailout'"
    ).get(userId);
    return (r && r.t) || 0;
  }

  /** What the page needs to decide whether to offer it, without guessing. */
  bailoutState(userId) {
    const balance = this.balance(userId);
    const last = this.lastBailout(userId);
    const readyAt = last ? last + BAILOUT.everyMs : 0;
    return {
      eligible: balance < BAILOUT.below && Date.now() >= readyAt,
      balance, below: BAILOUT.below, grant: BAILOUT.grant,
      readyAt: Date.now() < readyAt ? readyAt : 0,
    };
  }

  bailout(userId) {
    const st = this.bailoutState(userId);
    if (st.balance >= BAILOUT.below) {
      throw refuse(`grants are for when you are out — you still have ${st.balance} cents`);
    }
    if (st.readyAt) {
      const hours = Math.ceil((st.readyAt - Date.now()) / 3600000);
      throw refuse(`one grant a day — the next is in about ${hours} hour${hours === 1 ? '' : 's'}`);
    }
    // Re-read inside the write rather than trusting the check above: two
    // requests can both pass a check and only one should pass this.
    this.db.exec('BEGIN');
    try {
      const fresh = this.db.prepare(
        "SELECT MAX(created_at) AS t FROM ledger WHERE user_id = ? AND reason = 'bailout'"
      ).get(userId);
      if (fresh && fresh.t && Date.now() - fresh.t < BAILOUT.everyMs) {
        throw refuse('one grant a day');
      }
      const balance = this.#post(userId, BAILOUT.grant, 'bailout', null);
      this.db.exec('COMMIT');
      return { granted: BAILOUT.grant, balance };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Highest hand number this table has ever written, from the ledger itself. */
  lastHandNo(tableId) {
    const r = this.db.prepare(
      'SELECT MAX(CAST(SUBSTR(ref, ?) AS INTEGER)) AS n FROM ledger WHERE ref LIKE ?'
    ).get(tableId.length + 2, `${tableId}#%`);
    return (r && r.n) || 0;
  }

  settledUpto(tableId) {
    const r = this.db.prepare('SELECT settled_upto FROM table_state WHERE id = ?').get(tableId);
    return r ? r.settled_upto : 0;
  }

  markSettled(tableId, handNo) {
    this.db.prepare(
      `INSERT INTO table_state (id, settled_upto) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET settled_upto = MAX(settled_upto, excluded.settled_upto)`
    ).run(tableId, handNo);
  }

  /**
   * Give back every stake on a hand that was never settled, and return what
   * was handed to whom. Only the four reasons that take money off a player
   * count; a payout is not a stake, and a hand that merely lost is not
   * unsettled — it is settled, at zero.
   */
  /**
   * Pay a round out and record that it is closed, together. These must not be
   * two transactions: a crash in the gap leaves a round that has already paid
   * still looking open, and the next boot would refund stakes it had settled.
   * Entries may be empty — a round where every hand lost moves no money and is
   * closed just the same.
   */
  settleRound(tableId, handNo, entries = []) {
    this.db.exec('BEGIN');
    try {
      const out = entries.map(e => ({ userId: e.userId, balance: this.#post(e.userId, e.delta, e.reason, e.ref) }));
      this.db.prepare(
        `INSERT INTO table_state (id, settled_upto) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET settled_upto = MAX(settled_upto, excluded.settled_upto)`
      ).run(tableId, handNo);
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  refundOpenStakes(tableId) {
    const after = this.settledUpto(tableId);
    const upto  = this.lastHandNo(tableId);
    const open = this.db.prepare(
      `SELECT user_id AS userId, SUM(delta) AS staked FROM ledger
        WHERE reason IN ('bet','insurance','double','split')
          AND ref LIKE ?
          AND CAST(SUBSTR(ref, ?) AS INTEGER) > ?
        GROUP BY user_id`
    ).all(`${tableId}#%`, tableId.length + 2, after);
    const owed = open.filter(r => r.staked < 0);

    // The refund and the mark that it happened go in together. Split across
    // two transactions, a crash in the gap either pays twice or never pays at
    // all, which is the same class of bug this method exists to fix. The ref
    // deliberately does not parse as a hand number, so it cannot be mistaken
    // for one by lastHandNo.
    this.db.exec('BEGIN');
    try {
      const out = owed.map(r => ({
        userId: r.userId,
        cents: -r.staked,
        balance: this.#post(r.userId, -r.staked, 'refund', `${tableId}#recovered-after-${after}`),
      }));
      this.db.prepare(
        `INSERT INTO table_state (id, settled_upto) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET settled_upto = MAX(settled_upto, excluded.settled_upto)`
      ).run(tableId, upto);
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ------------------------------------------------------- who and how well */

  /** Find a player by the tag they would read out, or by their raw id. */
  findPlayer(handle) {
    const h = String(handle || '').trim();
    if (!h) return null;
    return this.db.prepare(
      'SELECT id, display, tag FROM users WHERE tag = ? OR id = ? LIMIT 1'
    ).get(h.toUpperCase(), h) || null;
  }

  /**
   * Read a player's record out of the ledger rather than keeping a second
   * copy of it. Gifts are deliberately left out of `net`: a leaderboard that
   * counts money someone was handed is a leaderboard of who has generous
   * friends, and it would make the gift feature the fastest way to the top.
   */
  stats(userId) {
    const one = (sql, ...args) => this.db.prepare(sql).get(userId, ...args) || {};
    const hands = one(
      "SELECT COUNT(DISTINCT ref) AS n FROM ledger WHERE user_id = ? AND reason = 'bet'"
    ).n || 0;
    const staked = -(one(
      "SELECT SUM(delta) AS s FROM ledger WHERE user_id = ? AND reason IN ('bet','double','split','insurance')"
    ).s || 0);
    const returned = one(
      "SELECT SUM(delta) AS s FROM ledger WHERE user_id = ? AND reason IN ('settle','insurance-win')"
    ).s || 0;
    const giftedOut = -(one(
      "SELECT SUM(delta) AS s FROM ledger WHERE user_id = ? AND reason = 'gift-sent'"
    ).s || 0);
    const giftedIn = one(
      "SELECT SUM(delta) AS s FROM ledger WHERE user_id = ? AND reason = 'gift-received'"
    ).s || 0;
    return { hands, staked, returned, net: returned - staked, giftedOut, giftedIn,
             balance: this.balance(userId) };
  }

  /**
   * Ranked by what they have won at the table, not by what they hold. Balance
   * would put whoever was gifted most at the top; this cannot be raised by
   * being given anything, only by playing well. Accounts that have never
   * played are left out rather than sitting at a meaningless zero.
   */
  leaderboard(limit = 20) {
    return this.db.prepare(
      `SELECT u.display, u.tag, u.balance,
              COUNT(DISTINCT CASE WHEN l.reason = 'bet' THEN l.ref END) AS hands,
              COALESCE(SUM(CASE
                WHEN l.reason IN ('settle','insurance-win')             THEN l.delta
                WHEN l.reason IN ('bet','double','split','insurance')   THEN l.delta
                ELSE 0 END), 0) AS net
         FROM users u LEFT JOIN ledger l ON l.user_id = u.id
        GROUP BY u.id
        HAVING hands > 0
        ORDER BY net DESC, hands DESC
        LIMIT ?`
    ).all(Math.min(100, Math.max(1, Number(limit) || 20)));
  }

  /** What this player has sent in the last day, for the cap. */
  giftedSince(userId, sinceMs) {
    const r = this.db.prepare(
      "SELECT SUM(delta) AS s FROM ledger WHERE user_id = ? AND reason = 'gift-sent' AND created_at >= ?"
    ).get(userId, sinceMs);
    return -((r && r.s) || 0);
  }

  /**
   * Move play money between two players. Both sides in one transaction: a gift
   * that debited and did not credit would be money destroyed, and the reverse
   * would be money invented.
   */
  gift(fromId, handle, cents) {
    cents = Math.floor(Number(cents) || 0);
    if (cents < GIFT.minCents) throw refuse(`the smallest gift is ${GIFT.minCents} cents`);
    if (cents > GIFT.maxCents) throw refuse(`the largest single gift is ${GIFT.maxCents} cents`);

    const to = this.findPlayer(handle);
    if (!to) throw refuse('no player with that tag');
    if (to.id === fromId) throw refuse('you cannot gift yourself');

    const me = this.stats(fromId);
    if (me.hands < GIFT.minHandsPlayed) {
      throw refuse(`play ${GIFT.minHandsPlayed} hands before gifting — you have played ${me.hands}`);
    }
    if (cents > me.balance) throw refuse('you do not have that much');

    const sentToday = this.giftedSince(fromId, now() - 86400000);
    if (sentToday + cents > GIFT.perDayCents) {
      throw refuse(`that is over your daily limit — ${GIFT.perDayCents - sentToday} cents left today`);
    }

    const ref = `gift:${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      const fromBalance = this.#post(fromId, -cents, 'gift-sent', ref);
      this.#post(to.id, cents, 'gift-received', ref);
      this.db.exec('COMMIT');
      return { to: { display: to.display, tag: to.tag }, cents, balance: fromBalance };
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
