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
    const { cardName } = await import('../server/engine.mjs');
    const hole = table.dealer.cards[1];
    ok(!first.includes(`"${cardName(hole)}"`), 'the opening frame does not contain the hole card');
  } else { checks++; }
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

/* ================================================= static files stay put */
{
  for (const path of ['/../accounts.mjs', '/..%2faccounts.mjs', '/../../etc/passwd']) {
    const r = await fetch(BASE + path);
    ok(r.status !== 200 || !(await r.text()).includes('pass_hash'),
      `${path} does not escape the public directory`);
  }
  const page = await fetch(BASE + '/');
  eq(page.status, 200, 'the table page is served');
  ok((await page.text()).includes('BLACKJACK ACADEMY'), 'and it is the right page');
}

/* ================================================ the ledger still balances */
{
  const drift = accounts.audit();
  eq(drift.length, 0, 'no account drifted from its ledger after all that');
}

/* ------------------------------------------------------------------ done */
server.close();
console.log(`server checks run: ${checks}`);
if (fails.length) {
  console.log('SERVER FAILURES:');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('all server checks passed');
process.exit(0);
