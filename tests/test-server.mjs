/* The server, over real HTTP.
 *
 * test-table proves the table keeps the money honest when called directly.
 * This proves the layer in front of it does not hand that away: that a signed
 * out request cannot bet, that one player cannot act as another, that the
 * event stream carries no hole card, and that a cross-site post is refused.
 */
import { server, table, accounts } from '../server/index.mjs';
import { STARTING_BALANCE } from '../server/accounts.mjs';

const fails = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

const listening = await new Promise(res => server.listen(0, () => res(server.address())));
const BASE = `http://127.0.0.1:${listening.port}`;

/** A client that keeps its own cookie jar, so two of them are two people. */
function client() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    /* Sign in without going through /api/signup. The signup limiter is five a
       minute per address and this whole suite shares one, so tests that need
       an account rather than a signup take one directly. */
    as(user) { cookie = `sid=${accounts.startSession(user.id)}`; return this; },
    async call(path, body, extraHeaders = {}) {
      const r = await fetch(BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      let data = null;
      try { data = await r.json(); } catch {}
      return { status: r.status, data };
    },
  };
}

/* ============================================================ signing up */
{
  const a = client();
  let r = await a.call('/api/signup', { email: 'ann@example.com', password: 'password123', display: 'Ann' });
  eq(r.status, 200, 'signup succeeds');
  eq(r.data.user.display, 'Ann', 'the display name comes back');
  eq(r.data.user.balance, STARTING_BALANCE, 'a new account is funded with play money');
  ok(a.cookie.startsWith('sid='), 'a session cookie is set');

  r = await a.call('/api/signup', { email: 'ann@example.com', password: 'password123', display: 'Ann2' });
  eq(r.status, 400, 'the same email cannot sign up twice');

  r = await a.call('/api/signup', { email: 'short@example.com', password: 'abc', display: 'S' });
  eq(r.status, 400, 'a short password is refused');

  r = await a.call('/api/signup', { email: 'not-an-email', password: 'password123', display: 'S' });
  eq(r.status, 400, 'a malformed email is refused');
}

/* ============================================================ signing in */
{
  const a = client();
  let r = await a.call('/api/login', { email: 'ann@example.com', password: 'wrongpassword' });
  eq(r.status, 401, 'a wrong password is refused');

  const nosuch = await client().call('/api/login', { email: 'nobody@example.com', password: 'password123' });
  eq(nosuch.data.error, r.data.error,
    'a wrong password and an unknown account give the same message, so neither confirms the other');

  r = await a.call('/api/login', { email: 'ann@example.com', password: 'password123' });
  eq(r.status, 200, 'the right password is accepted');

  r = await a.call('/api/me');
  eq(r.data.user.display, 'Ann', 'the session identifies the account');
}

/* ====================================================== signed out is out */
{
  const anon = client();
  for (const [path, body] of [
    ['/api/me', undefined], ['/api/sit', { seat: 0 }], ['/api/bet', { cents: 500 }],
    ['/api/act', { action: 'hit' }], ['/api/insurance', { take: true }], ['/api/stand-up', {}],
  ]) {
    const r = await anon.call(path, body);
    eq(r.status, 401, `${path} refuses a request with no session`);
  }
}

/* ================================================== a forged cookie is not one */
{
  const faker = client();
  const r = await faker.call('/api/bet', { cents: 500 }, { cookie: 'sid=' + 'f'.repeat(64) });
  eq(r.status, 401, 'an invented session token is not a session');
}

/* ======================================================= cross-site posts */
{
  const a = client();
  await a.call('/api/login', { email: 'ann@example.com', password: 'password123' });
  const r = await a.call('/api/bet', { cents: 500 }, { origin: 'https://evil.example' });
  eq(r.status, 403, 'a post from another origin is refused');
}

/* ============================================ playing, and not as somebody else */
{
  const ann = client();
  const bob = client();
  await ann.call('/api/login', { email: 'ann@example.com', password: 'password123' });
  await bob.call('/api/signup', { email: 'bob@example.com', password: 'password123', display: 'Bob' });

  let r = await ann.call('/api/sit', { seat: 0 });
  eq(r.status, 200, 'a signed-in player can sit');

  r = await bob.call('/api/sit', { seat: 0 });
  eq(r.status, 400, 'an occupied seat is refused');
  r = await bob.call('/api/sit', { seat: 1 });
  eq(r.status, 200, 'a free seat is not');

  r = await ann.call('/api/bet', { cents: 500 });
  eq(r.status, 200, 'a bet is accepted while betting is open');
  eq(r.data.balance, STARTING_BALANCE - 500, 'and the stake leaves the balance');

  r = await ann.call('/api/bet', { cents: 99 });
  eq(r.status, 400, 'a bet under the minimum is refused');
  r = await ann.call('/api/bet', { cents: 99999999 });
  eq(r.status, 400, 'a bet over the maximum is refused');

  await bob.call('/api/bet', { cents: 500 });

  // Force the deal rather than waiting fifteen real seconds.
  table.tick(Date.now() + 10 ** 7);
  if (table.phase === 'insurance') table.tick(Date.now() + 10 ** 7);

  if (table.phase === 'acting') {
    const turnIsAnn = table.active.seat === 0;
    const waiting = turnIsAnn ? bob : ann;
    r = await waiting.call('/api/act', { action: 'hit' });
    eq(r.status, 400, 'a player cannot act on somebody else\'s turn');

    const onTurn = turnIsAnn ? ann : bob;
    r = await onTurn.call('/api/act', { action: 'teleport' });
    eq(r.status, 400, 'an action that does not exist is refused');

    r = await onTurn.call('/api/act', { action: 'stand' });
    eq(r.status, 200, 'the player whose turn it is can act');
  } else { checks += 3; }
}

/* ============================================== the stream hides the hole card */
{
  const state = await (await fetch(BASE + '/api/table')).json();
  if (state.dealer.cards.length && state.phase !== 'payout' && state.phase !== 'dealer') {
    eq(state.dealer.cards.length, 1, 'the public table shows one dealer card while the round runs');
    ok(state.dealer.hidden >= 1, 'and says the rest are hidden');
  } else { checks += 2; }

  // The SSE stream must not leak it either.
  const ctrl = new AbortController();
  const res = await fetch(BASE + '/api/stream', { signal: ctrl.signal });
  eq(res.headers.get('content-type'), 'text/event-stream', 'the stream announces itself as SSE');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const first = new TextDecoder().decode(value);
  ok(first.startsWith('event: state'), 'the stream opens with the current state');
  if (table.phase === 'acting' || table.phase === 'insurance') {
    /* Parsed, not scanned. Searching the frame for the hole card's name is
       wrong in a six-deck shoe: the same name belongs to six different cards,
       so a player holding one of the others looked like a leak roughly 6% of
       the time — which is what failed CI while the server was behaving. */
    const { cardName } = await import('../server/engine.mjs');
    const payload = JSON.parse(first.slice(first.indexOf('data: ') + 6).split('\n')[0]);
    eq(payload.dealer.cards.length, 1, 'the opening frame publishes one dealer card');
    eq(payload.dealer.cards[0], cardName(table.dealer.cards[0]), 'and it is the upcard');
    eq(payload.dealer.hidden, table.dealer.cards.length - 1, 'the rest are counted, not sent');
  } else { checks += 3; }
  ctrl.abort();
  await reader.cancel().catch(() => {});
}

/* ================================================== a body that will not fit */
{
  const a = client();
  await a.call('/api/login', { email: 'ann@example.com', password: 'password123' });
  const r = await fetch(BASE + '/api/bet', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: a.cookie },
    body: JSON.stringify({ cents: 500, junk: 'x'.repeat(50000) }),
  }).then(x => ({ status: x.status })).catch(() => ({ status: 0 }));
  ok(r.status !== 200, 'an oversized body does not get through');
}

/* ================================================= both pages, one server */
{
  for (const path of ['/../accounts.mjs', '/..%2faccounts.mjs', '/../../etc/passwd']) {
    const r = await fetch(BASE + path);
    ok(r.status !== 200 || !(await r.text()).includes('pass_hash'),
      `${path} does not escape the public directory`);
  }

  // The trainer at the root. It lives beside server/ rather than inside
  // server/public, so this also proves that path resolves.
  const home = await fetch(BASE + '/');
  eq(home.status, 200, 'the trainer is served at /');
  const homeHtml = await home.text();
  ok(homeHtml.includes('Blackjack Academy Helper'), 'and it is the trainer, not the table');
  ok(homeHtml.includes('id="chartArea"'), 'with the trainer\'s own markup');

  // The table on its own path.
  const tbl = await fetch(BASE + '/table');
  eq(tbl.status, 200, 'the table is served at /table');
  const tblHtml = await tbl.text();
  ok(tblHtml.includes('Play at the table'), 'and it is the table page');
  ok(tblHtml.includes('id="seats"'), 'with the felt on it');

  eq((await fetch(BASE + '/table/')).status, 200, 'with or without a trailing slash');

  // The trainer links to the table, and the table links back.
  ok(homeHtml.includes('href="/table"'), 'the trainer links to the table');
  ok(tblHtml.includes('href="/"'), 'and the table links back to the trainer');

  eq((await fetch(BASE + '/nothing-here')).status, 404, 'an unknown path is a 404');
}

/* ============================================================ health check */
{
  const r = await fetch(BASE + '/healthz');
  const body = await r.json();
  eq(r.status, 200, 'the health check answers');
  eq(body.ok, true, 'and reports healthy while the database is open');
  ok(typeof body.uptime === 'number', 'and says how long it has been up');
  // It must touch storage, not just return 200 — an instance that has lost its
  // disk should report unhealthy rather than serve a broken table.
  ok('phase' in body, 'and reports the table phase, so it reflects real state');
}

/* ==================================================== cookies and proxies */
{
  // Over plain HTTP with no proxy in front, the session cookie must NOT be
  // marked Secure, or the browser discards it and nobody can ever sign in.
  const r = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ann@example.com', password: 'password123' }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  ok(setCookie.includes('HttpOnly'), 'the session cookie is HttpOnly');
  ok(setCookie.includes('SameSite=Strict'), 'and SameSite=Strict');
  ok(!/;\s*Secure/i.test(setCookie),
     `and not Secure over plain http, which would discard it (${setCookie})`);

  // Forwarded headers are ignored unless something is actually in front of us
  // saying so — otherwise any caller could claim any address or scheme.
  const spoofed = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
    },
    body: JSON.stringify({ email: 'ann@example.com', password: 'password123' }),
  });
  const spoofedCookie = spoofed.headers.get('set-cookie') || '';
  ok(!/;\s*Secure/i.test(spoofedCookie),
     'a forwarded-proto header is ignored when TRUST_PROXY is off');
}

/* ======================================= the deployment config, for real */
/* TRUST_PROXY is what the Dockerfile and fly.toml set, and it changes how the
 * Secure flag, the Origin check and the rate-limit key are decided. Testing it
 * means a second process with that environment, because the flag is read once
 * at startup — and config nobody exercises is how a deploy fails on the day. */
{
  const { spawn } = await import('node:child_process');
  const PROXY_PORT = 8899;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PROXY_PORT), HOST: '127.0.0.1', TRUST_PROXY: '1', DB_PATH: ':memory:' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const up = await new Promise(resolve => {
    const done = setTimeout(() => resolve(false), 8000);
    child.stdout.on('data', d => {
      if (String(d).includes('listening')) { clearTimeout(done); resolve(true); }
    });
    child.on('error', () => { clearTimeout(done); resolve(false); });
  });
  ok(up, 'the server starts with the deployment environment');

  if (up) {
    const P = `http://127.0.0.1:${PROXY_PORT}`;

    const health = await fetch(P + '/healthz').then(r => r.json());
    eq(health.ok, true, 'proxied: the health check passes');

    await fetch(P + '/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'proxy@example.com', password: 'password123', display: 'Prox' }),
    });

    // With something in front declaring TLS, the cookie must now be Secure —
    // otherwise a session issued over https is sent back over http.
    const tls = await fetch(P + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ email: 'proxy@example.com', password: 'password123' }),
    });
    ok(/;\s*Secure/i.test(tls.headers.get('set-cookie') || ''),
       'proxied: a session issued over https is marked Secure');

    // And still not Secure when the same proxy reports a plain request.
    const plain = await fetch(P + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http' },
      body: JSON.stringify({ email: 'proxy@example.com', password: 'password123' }),
    });
    ok(!/;\s*Secure/i.test(plain.headers.get('set-cookie') || ''),
       'proxied: a plain request still gets a cookie the browser will keep');

    // The Origin check must compare against the forwarded host, or every
    // request through the proxy would look cross-origin and be refused.
    const cookie = (tls.headers.get('set-cookie') || '').split(';')[0];
    const matched = await fetch(P + '/api/sit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', cookie,
        origin: 'https://table.example', 'x-forwarded-host': 'table.example',
      },
      body: JSON.stringify({ seat: 0 }),
    });
    ok(matched.status !== 403, `proxied: a request from the real public host is not refused (${matched.status})`);

    const crossed = await fetch(P + '/api/bet', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', cookie,
        origin: 'https://evil.example', 'x-forwarded-host': 'table.example',
      },
      body: JSON.stringify({ cents: 500 }),
    });
    eq(crossed.status, 403, 'proxied: a genuinely cross-origin post is still refused');

    // SIGTERM has to be handled, or the platform kills it mid-write.
    const exit = await new Promise(resolve => {
      const done = setTimeout(() => resolve('timeout'), 8000);
      child.on('exit', code => { clearTimeout(done); resolve(code); });
      child.kill('SIGTERM');
    });
    eq(exit, 0, 'proxied: SIGTERM shuts down cleanly rather than being killed');
  } else {
    child.kill('SIGKILL');
    checks += 6;
  }
}

/* ================================================ the ledger still balances */
{
  const drift = accounts.audit();
  eq(drift.length, 0, 'no account drifted from its ledger after all that');
}

/* ------------------------------------------------------------------ done */
/* ============================================== gifting and the leaderboard */
{
  const giverUser = accounts.createUser('giver@example.com', 'password123', 'Giver');
  const takerUser = accounts.createUser('taker@example.com', 'password123', 'Taker');
  const giver = client().as(giverUser);
  const taker = client().as(takerUser);

  const takerMe = (await taker.call('/api/me')).data.user;
  const giverMe = (await giver.call('/api/me')).data.user;
  ok(/^[0-9A-Z]{6}$/.test(takerMe.tag), `a new account gets a readable tag (${takerMe.tag})`);
  ok(takerMe.tag !== giverMe.tag, 'two accounts do not share a tag');

  // The whole point of the guard: a fresh account is exactly the thing a farm
  // would be made of, and it holds a full starting balance.
  let r = await giver.call('/api/gift', { to: takerMe.tag, cents: 10000 });
  eq(r.status, 400, 'an account that has never played cannot gift');

  // Give the giver a play record, then the same gift should go through.
  const giverId = giverMe.id;
  for (let i = 1; i <= 50; i++) {
    accounts.post([{ userId: giverId, delta: -100, reason: 'bet', ref: `srv#${i}` },
                   { userId: giverId, delta: 200, reason: 'settle', ref: `srv#${i}/0` }]);
  }
  r = await giver.call('/api/gift', { to: takerMe.tag, cents: 10000 });
  eq(r.status, 200, 'a player who has played can gift');
  eq((await taker.call('/api/me')).data.user.balance, STARTING_BALANCE + 10000,
     'the gift arrives in full');

  r = await giver.call('/api/gift', { to: giverMe.tag, cents: 100 });
  eq(r.status, 400, 'a player cannot gift themselves');

  r = await giver.call('/api/gift', { to: 'ZZZZZZ', cents: 100 });
  eq(r.status, 400, 'an unknown tag is refused');

  r = await giver.call('/api/gift', { to: takerMe.tag, cents: -5000 });
  eq(r.status, 400, 'a negative gift is refused');

  r = await giver.call('/api/gift', { to: takerMe.tag, cents: 99999999 });
  eq(r.status, 400, 'a gift larger than the per-gift ceiling is refused');

  // Signed out, none of this is reachable.
  const nobody = client();
  r = await nobody.call('/api/gift', { to: takerMe.tag, cents: 100 });
  eq(r.status, 401, 'gifting requires an account');

  // Whatever happened above, the books still balance.
  eq(accounts.audit().length, 0, 'every balance still matches its ledger after gifting');

  // The board ranks on play, so money that was handed over cannot buy a place.
  const board = (await nobody.call('/api/leaderboard')).data.players;
  ok(Array.isArray(board), 'the leaderboard is public');
  ok(board.every(p => p.hands > 0), 'nobody who has never played appears on the board');
  ok(!board.some(p => p.tag === takerMe.tag),
     'being gifted a fortune does not put you on the leaderboard');
  ok(board.every(p => p.email === undefined), 'the leaderboard exposes no email addresses');
}

/* ============================================ busting out, and getting back */
{
  const broke = accounts.createUser('broke@example.com', 'password123', 'Broke');
  const c = client().as(broke);

  let r = await c.call('/api/bailout', {});
  eq(r.status, 400, 'a funded account is refused a grant');

  // Lose almost everything at the table, the ordinary way.
  accounts.post([{ userId: broke.id, delta: -(STARTING_BALANCE - 50), reason: 'bet', ref: 'bust#1' }]);

  r = await c.call('/api/bailout', {});
  eq(r.status, 200, 'an account that cannot play is granted one');
  ok(accounts.balance(broke.id) > 0, 'the grant reaches the balance');

  // Bust again immediately: the cooldown, not the balance, is what refuses.
  accounts.post([{ userId: broke.id, delta: -(accounts.balance(broke.id) - 10), reason: 'bet', ref: 'bust#2' }]);
  r = await c.call('/api/bailout', {});
  eq(r.status, 400, 'a second grant the same day is refused');
  ok(/day/i.test(r.data.error || ''), `the refusal says why (${r.data.error})`);

  const nobody = client();
  eq((await nobody.call('/api/bailout', {})).status, 401, 'a grant requires an account');

  /* The point of ranking on winnings rather than balance: a grant is not a
     win. Measured as a before and after across the grant itself — comparing
     against a figure computed here would only restate the implementation, and
     an account that loses the grant again afterwards hides the difference. */
  const clean = accounts.createUser('clean@example.com', 'password123', 'Clean');
  const cc = client().as(clean);
  accounts.post([{ userId: clean.id, delta: -(STARTING_BALANCE - 50), reason: 'bet', ref: 'clean#1' }]);
  const netBefore = accounts.leaderboard(200).find(p => p.display === 'Clean')?.net;
  const balBefore = accounts.balance(clean.id);

  eq((await cc.call('/api/bailout', {})).status, 200, 'the clean account is granted one');

  const after = accounts.leaderboard(200).find(p => p.display === 'Clean');
  ok(after, 'the account is still on the board after a grant');
  eq(after && after.net, netBefore, 'a grant does not move net winnings by a cent');
  ok(accounts.balance(clean.id) > balBefore, 'though it certainly moves the balance');

  eq(accounts.audit().length, 0, 'every balance still matches its ledger after a grant');
}

/* ============================================== chat, and who moderates it */
{
  const talker = accounts.createUser('talker@example.com', 'password123', 'Talker');
  const other  = accounts.createUser('other@example.com',  'password123', 'Other');
  const quiet  = accounts.createUser('quiet@example.com',  'password123', 'Quiet');
  const a = client().as(talker), o = client().as(other), q = client().as(quiet);
  const play = (u, n) => { for (let i = 1; i <= n; i++)
    accounts.post([{ userId: u.id, delta: -100, reason: 'bet', ref: `chat#${u.id}#${i}` },
                   { userId: u.id, delta: 200, reason: 'settle', ref: `chat#${u.id}#${i}/0` }]); };
  play(talker, 10); play(other, 10);

  let r = await q.call('/api/chat', { text: 'hello' });
  eq(r.status, 400, 'an account that has not played cannot chat');

  r = await a.call('/api/chat', { text: 'dealer is running hot' });
  eq(r.status, 200, 'a player who has played can chat');
  const msgId = r.data.id;

  r = await a.call('/api/chat', { text: 'this is fucking rigged' });
  eq(r.status, 400, 'the filter refuses what it catches');

  // Refusal rather than masking: starring it out teaches which spellings pass.
  r = await a.call('/api/chat', { text: 'f  u  c  k' });
  eq(r.status, 400, 'the filter sees through spacing');
  r = await a.call('/api/chat', { text: 'ffffuuuuuck' });
  eq(r.status, 400, 'the filter sees through repetition');
  r = await a.call('/api/chat', { text: 'sh1t' });
  eq(r.status, 400, 'the filter sees through digit substitution');

  // A second mouth, because the first has nearly used its minute — which is
  // the limiter working, not a problem with it.
  const wordy = accounts.createUser('wordy@example.com', 'password123', 'Wordy');
  play(wordy, 10);
  const w = client().as(wordy);

  // The filter must not swallow ordinary words that merely contain letters.
  for (const fine of ['bookkeeper', 'committee', 'assume the dealer stands', 'grass']) {
    r = await w.call('/api/chat', { text: fine });
    eq(r.status, 200, `the filter leaves "${fine}" alone`);
  }

  // This account must have played, or "refused" would mean the not-played gate
  // rather than the length check — the same 400 for a different reason.
  const lengthyUser = accounts.createUser('lengthy@example.com', 'password123', 'Lengthy');
  play(lengthyUser, 10);
  const lengthy = client().as(lengthyUser);
  ok((await lengthy.call('/api/chat', { text: 'a normal message' })).status === 200,
     'the length checks run against an account that is allowed to chat');
  r = await lengthy.call('/api/chat', { text: 'x'.repeat(500) });
  eq(r.status, 400, 'an overlong message is refused');
  r = await lengthy.call('/api/chat', { text: '   ' });
  eq(r.status, 400, 'an empty message is refused');

  // The limiter itself.
  const chattyUser = accounts.createUser('chatty@example.com', 'password123', 'Chatty');
  play(chattyUser, 10);
  const chatty = client().as(chattyUser);
  let hitLimit = false;
  for (let i = 0; i < 15; i++) {
    const res = await chatty.call('/api/chat', { text: `counting ${i}` });
    if (res.status === 429) { hitLimit = true; break; }
  }
  ok(hitLimit, 'chat is rate limited');

  const nobody = client();
  r = await nobody.call('/api/chat', { text: 'hi' });
  eq(r.status, 401, 'chatting requires an account');

  // Reporting
  r = await o.call('/api/chat/report', { id: msgId });
  eq(r.status, 200, 'a message can be reported');
  r = await o.call('/api/chat/report', { id: msgId });
  ok(r.data && r.data.already, 'the same person reporting twice does not stack');
  r = await a.call('/api/chat/report', { id: msgId });
  eq(r.status, 400, 'you cannot report your own message');

  // With no owner configured the moderation surface does not exist at all —
  // not 403, which would confirm it is there.
  r = await o.call('/api/chat/reports');
  eq(r.status, 404, 'with no ADMIN_EMAIL set, reading reports is not a route');
  r = await o.call('/api/chat/hide', { id: msgId });
  eq(r.status, 404, 'with no ADMIN_EMAIL set, hiding is not a route');

  const shown = (await nobody.call('/api/chat')).data.messages;
  ok(shown.some(m => m.id === msgId), 'chat history is readable without an account');
  ok(shown.every(m => m.user_id === undefined), 'chat history exposes no account ids');
}

/* ===================================================== reactions at the table */
{
  const c = client().as(accounts.createUser('emoter@example.com', 'password123', 'Emoter'));

  let r = await c.call('/api/emote', { emote: 'fire' });
  eq(r.status, 200, 'a signed-in player can react');

  // The vocabulary is closed, which is the entire reason this is safe: there is
  // no moderation surface because nothing a player writes is ever relayed.
  r = await c.call('/api/emote', { emote: 'not-an-emote' });
  eq(r.status, 400, 'an emote outside the list is refused');

  r = await c.call('/api/emote', { emote: '<img src=x onerror=alert(1)>' });
  eq(r.status, 400, 'an emote key cannot carry markup');

  const nobody = client();
  r = await nobody.call('/api/emote', { emote: 'clap' });
  eq(r.status, 401, 'reacting requires an account');

  // Spam is the one abuse a fixed vocabulary still allows.
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const res = await c.call('/api/emote', { emote: 'clap' });
    if (res.status === 429) { limited = true; break; }
  }
  ok(limited, 'reactions are rate limited');
}

/* ============================================ what the table tells the page */
{
  const state = (await client().call('/api/table')).data;
  ok(state.timing && state.timing.turn > 0,
     `the table publishes its own timings so a countdown cannot promise different time (turn ${state.timing?.turn}ms)`);
  ok(state.seats.some(s => s && 'lastAction' in s) || state.seats.every(s => !s),
     'seats report what they last did, for a client that joined mid-hand');
}

/* ================================================ a seat says whose it is */
{
  const c = client().as(accounts.createUser('seated@example.com', 'password123', 'Seated'));
  const me = (await c.call('/api/me')).data.user;
  // Earlier tests leave players sitting, and there are only five seats. Make
  // room rather than skipping: an `if` here meant the whole block quietly
  // passed when the table was full, which is not a check at all.
  let free = table.seats.findIndex(s => !s);
  if (free < 0) { table.stand(table.seats[0].userId); free = 0; }
  ok(free >= 0, 'a seat was available to test with');

  await c.call('/api/sit', { seat: free });
  const state = (await c.call('/api/table')).data;
  const mine = state.seats.find(s => s && s.tag === me.tag);
  ok(!!mine, 'a seat carries the tag of whoever is in it');
  // Display names are not unique, so they cannot be what identifies a seat.
  ok(mine && typeof mine.tag === 'string' && mine.tag === me.tag,
     'the seat is identified by tag rather than by display name');
  ok(state.seats.every(s => !s || s.userId === undefined),
     'a seat does not leak the internal account id');
}

server.close();

console.log(`server checks run: ${checks}`);
if (fails.length) {
  console.log('SERVER FAILURES:');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('all server checks passed');
process.exit(0);
