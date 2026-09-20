/* The game server: HTTP for actions, Server-Sent Events for the table.
 *
 * SSE rather than WebSockets on purpose. A turn-based card game does not need
 * a duplex socket, SSE reconnects on its own, it survives proxies that mangle
 * upgrades, and — the reason that decided it — it is in Node already. The whole
 * server still has no runtime dependency, which is the property this project
 * has kept from the beginning.
 *
 * Every endpoint that changes anything checks the session and the Origin. The
 * client is never trusted for anything but intent: which seat, how much, which
 * action. What that means for the cards is decided in table.mjs.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, Accounts } from './accounts.mjs';
import { Table, SEATS } from './table.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || ':memory:';

const db = openDb(DB_PATH);
const accounts = new Accounts(db);

/* ------------------------------------------------------------- listeners */
/** Everyone currently watching a table, so an event can be pushed to them. */
const watchers = new Set();

function broadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of watchers) {
    try { res.write(frame); } catch { watchers.delete(res); }
  }
}

const table = new Table({ id: 'main', accounts, onEvent: broadcast });

// The table's clock. Everything time-based — betting closing, a turn expiring,
// the payout pause — happens because of this, not because a client asked.
setInterval(() => {
  try { table.tick(); } catch (e) { console.error('tick failed:', e); }
}, 250).unref?.();

/* ------------------------------------------------------------- plumbing */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const send = (res, code, body, headers = {}) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : MIME['.json'],
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
};

const fail = (res, code, message) => send(res, code, { error: message });

async function readJson(req, limit = 4096) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    // A body that will not fit is refused rather than buffered forever.
    if (body.length > limit) { req.destroy(); throw new Error('request too large'); }
  }
  return body ? JSON.parse(body) : {};
}

const cookies = req => Object.fromEntries(
  (req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }).filter(([k]) => k)
);

const sessionCookie = token =>
  `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}` +
  (process.env.SECURE_COOKIE === '1' ? '; Secure' : '');

const userFor = req => accounts.userForSession(cookies(req).sid);

/**
 * A cookie plus SameSite=Strict already stops a cross-site form posting here,
 * but browsers differ and the check is one line, so the Origin is verified too.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                    // not a browser, or a same-origin GET
  try {
    const host = req.headers.host;
    return new URL(origin).host === host;
  } catch { return false; }
}

/* --------------------------------------------------------- rate limiting */
/* Enough to stop someone walking a password list, not a substitute for the
   real thing in front of a real deployment. */
const hits = new Map();
function tooMany(key, max = 10, windowMs = 60000) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.start > windowMs) { hits.set(key, { start: now, n: 1 }); return false; }
  rec.n++;
  return rec.n > max;
}
setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
}, 60000).unref?.();

/* ------------------------------------------------------------- the routes */
const ROUTES = {
  'POST /api/signup': async (req, res) => {
    if (tooMany(`signup:${req.socket.remoteAddress}`, 5)) return fail(res, 429, 'too many attempts, wait a minute');
    const { email, password, display } = await readJson(req);
    const user = accounts.createUser(email, password, display);
    const token = accounts.startSession(user.id);
    send(res, 200, { user }, { 'set-cookie': sessionCookie(token) });
  },

  'POST /api/login': async (req, res) => {
    if (tooMany(`login:${req.socket.remoteAddress}`, 10)) return fail(res, 429, 'too many attempts, wait a minute');
    const { email, password } = await readJson(req);
    const user = accounts.verifyPassword(email, password);
    // One message for both cases: saying which was wrong tells an attacker
    // which addresses have accounts.
    if (!user) return fail(res, 401, 'that email and password do not match');
    const token = accounts.startSession(user.id);
    send(res, 200, { user }, { 'set-cookie': sessionCookie(token) });
  },

  'POST /api/logout': async (req, res) => {
    accounts.endSession(cookies(req).sid);
    send(res, 200, { ok: true }, { 'set-cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  },

  'GET /api/me': async (req, res) => {
    const user = userFor(req);
    if (!user) return fail(res, 401, 'not signed in');
    send(res, 200, { user, history: accounts.history(user.id, 20) });
  },

  'POST /api/sit': async (req, res) => {
    const user = userFor(req);
    if (!user) return fail(res, 401, 'not signed in');
    const { seat } = await readJson(req);
    send(res, 200, { seat: table.sit(Number(seat), user), state: table.publicState() });
  },

  'POST /api/stand-up': async (req, res) => {
    const user = userFor(req);
    if (!user) return fail(res, 401, 'not signed in');
    table.stand(user.id);
    send(res, 200, { state: table.publicState() });
  },

  'POST /api/bet': async (req, res) => {
    const user = userFor(req);
    if (!user) return fail(res, 401, 'not signed in');
    const { cents } = await readJson(req);
    table.placeBet(user.id, cents);
    send(res, 200, { balance: accounts.balance(user.id), state: table.publicState() });
  },

  'POST /api/insurance': async (req, res) => {
    const user = userFor(req);
    if (!user) return fail(res, 401, 'not signed in');
    const { take } = await readJson(req);
    table.takeInsurance(user.id, !!take);
    send(res, 200, { balance: accounts.balance(user.id), state: table.publicState() });
  },

  'POST /api/act': async (req, res) => {
    const user = userFor(req);
    if (!user) return fail(res, 401, 'not signed in');
    const { action } = await readJson(req);
    table.act(user.id, String(action));
    send(res, 200, { balance: accounts.balance(user.id), state: table.publicState() });
  },

  'GET /api/table': async (req, res) => send(res, 200, table.publicState()),

  /* The live feed. One long-lived response per watcher; the table pushes into it. */
  'GET /api/stream': async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',        // stops nginx holding the stream in a buffer
    });
    res.write(`event: state\ndata: ${JSON.stringify(table.publicState())}\n\n`);
    watchers.add(res);

    // A comment line every 25s, so idle proxies do not decide the connection died.
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(beat); watchers.delete(res); });
  },
};

/* ------------------------------------------------------------ the server */
export const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (ROUTES[route]) {
      if (req.method !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'cross-origin request refused');
      return await ROUTES[route](req, res);
    }
    if (req.method !== 'GET') return fail(res, 404, 'no such endpoint');

    // Static files, confined to server/public — a path that climbs out is refused.
    const rel = url.pathname === '/' ? 'table.html' : url.pathname.slice(1);
    const path = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!path.startsWith(PUBLIC)) return fail(res, 403, 'no');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    if (e?.code === 'ENOENT') return fail(res, 404, 'not found');
    // A rule the table refused is the caller's problem, not a server fault.
    const client = /already|cannot|not your|refused|insufficient|minimum|maximum|taken|no such|closed|not open|not seated|not in this|does not look|at least|too large/i.test(e.message || '');
    if (!client) console.error(route, e);
    fail(res, client ? 400 : 500, client ? e.message : 'something went wrong');
  }
});

// Only listen when run directly; importing this in a test must not open a port.
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  server.listen(PORT, () => {
    console.log(`blackjack table on http://localhost:${PORT}`);
    console.log(`  storage: ${DB_PATH === ':memory:' ? 'in memory (nothing survives a restart)' : DB_PATH}`);
    console.log(`  play money only — no deposits, no withdrawals, nothing to cash out`);
  });
}

export { table, accounts, db };
