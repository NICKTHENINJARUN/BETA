/* Table chat.
 *
 * The hard part of chat is not the messages, it is that you now own whatever
 * strangers type at each other on your site. Four things carry that here, and
 * none of them is sufficient alone:
 *
 *   a filter    — catches the obvious and nothing clever. Anyone determined
 *                 walks around a wordlist in seconds; this is a speed bump for
 *                 the thoughtless, not a defence against the deliberate.
 *   muting      — per viewer, held in their own browser. Nobody needs the
 *                 server's permission to stop reading someone, and a mute that
 *                 needed a round trip would be a mute you could be denied.
 *   reporting   — puts a message in front of the owner. Stored against the
 *                 message id, one per person, so ten friends cannot manufacture
 *                 a queue.
 *   hiding      — the owner's actual lever. The row survives; `hidden` is set,
 *                 so a report still points at something real afterwards.
 *
 * Messages are kept rather than only broadcast so that someone joining
 * mid-shoe sees the last few, and so a report refers to something that still
 * exists.
 */

export const CHAT = {
  maxLength: 200,
  history: 40,
  perMinute: 8,
  minHandsPlayed: 5,      // lower than gifting: talking is not taking
};

/* Deliberately short, and deliberately not a slur list expanded to look
   thorough. A long wordlist reads like protection and is not: it catches
   spellings nobody uses while missing the ones people do, and every entry is
   another word an innocent message can trip over. The mute and the report are
   what actually work; this stops the laziest quarter of it. */
const BLOCKED = [
  'fuck', 'shit', 'bitch', 'cunt', 'whore', 'faggot', 'nigger', 'retard',
];

/* Collapse the tricks that cost nothing to defeat: spacing, repetition and the
   handful of digits that stand in for letters. Anything past this is beyond
   what a wordlist can do, which is the point of the other three mechanisms. */
function normalise(text) {
  return String(text).toLowerCase()
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, '')
    // Every run to a single character, so ffffuuuuck reduces to the word it is
    // pretending not to be. The list is normalised the same way, or entries
    // with a doubled letter would stop matching themselves.
    .replace(/(.)\1+/g, '$1');
}

const BLOCKED_FLAT = BLOCKED.map(normalise);

export function blockedWord(text) {
  const flat = normalise(text);
  const i = BLOCKED_FLAT.findIndex(w => flat.includes(w));
  return i < 0 ? null : BLOCKED[i];
}

function refuse(message) {
  const e = new Error(message);
  e.expected = true;
  return e;
}

export class Chat {
  constructor(db, accounts) { this.db = db; this.accounts = accounts; }

  /** The last few messages, oldest first, with whoever is hidden left out. */
  recent(limit = CHAT.history) {
    const rows = this.db.prepare(
      `SELECT c.id, c.text, c.created_at AS at, u.display, u.tag
         FROM chat c JOIN users u ON u.id = c.user_id
        WHERE c.hidden = 0
        ORDER BY c.id DESC LIMIT ?`
    ).all(Math.min(100, Math.max(1, limit)));
    return rows.reverse();
  }

  say(user, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) throw refuse('say something first');
    if (text.length > CHAT.maxLength) throw refuse(`keep it under ${CHAT.maxLength} characters`);

    const played = this.accounts.stats(user.id).hands;
    if (played < CHAT.minHandsPlayed) {
      throw refuse(`play ${CHAT.minHandsPlayed} hands before chatting — you have played ${played}`);
    }

    // Refused rather than masked. Starring it out teaches people which
    // spellings get through, and leaves them thinking they were heard.
    const bad = blockedWord(text);
    if (bad) throw refuse('that one is not going to make it past the filter');

    const at = Date.now();
    const info = this.db.prepare('INSERT INTO chat (user_id,text,created_at) VALUES (?,?,?)')
      .run(user.id, text, at);
    return { id: Number(info.lastInsertRowid), text, at, display: user.display, tag: user.tag || null };
  }

  report(messageId, reporterId) {
    const msg = this.db.prepare('SELECT id, user_id FROM chat WHERE id = ?').get(Number(messageId));
    if (!msg) throw refuse('no such message');
    if (msg.user_id === reporterId) throw refuse('you cannot report yourself');
    try {
      this.db.prepare('INSERT INTO chat_reports (message_id,reporter_id,created_at) VALUES (?,?,?)')
        .run(msg.id, reporterId, Date.now());
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) return { already: true };
      throw e;
    }
    return { reported: true };
  }

  /** What the owner needs to look at: most-reported first, still visible. */
  reports(limit = 50) {
    return this.db.prepare(
      `SELECT c.id, c.text, c.created_at AS at, c.hidden, u.display, u.tag,
              COUNT(r.id) AS reports
         FROM chat_reports r
         JOIN chat c ON c.id = r.message_id
         JOIN users u ON u.id = c.user_id
        GROUP BY c.id
        ORDER BY c.hidden ASC, reports DESC, c.id DESC
        LIMIT ?`
    ).all(Math.min(200, Math.max(1, limit)));
  }

  hide(messageId, hidden = true) {
    const r = this.db.prepare('UPDATE chat SET hidden = ? WHERE id = ?')
      .run(hidden ? 1 : 0, Number(messageId));
    if (!r.changes) throw refuse('no such message');
    return { id: Number(messageId), hidden: !!hidden };
  }
}
