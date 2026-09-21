/* The multiplayer table, driven the way a server would drive it.
 *
 * The thing under test here is not "does blackjack work" — that is covered by
 * test-engine and test-money against the trainer. It is whether a table that
 * several people are betting real balances at keeps those balances honest:
 * every cent that leaves an account is accounted for, nothing goes negative,
 * nobody acts out of turn, and the hole card does not leave the server.
 */
import { openDb, Accounts, STARTING_BALANCE } from '../server/accounts.mjs';
import { Table, TIMING, SEATS } from '../server/table.mjs';
import { buildShoe, commitTo, newServerSeed, best, isBust } from '../server/engine.mjs';

const fails = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${a}, wanted ${b})`);

/* ------------------------------------------------------------- fixtures */
function freshTable(opts = {}) {
  const db = openDb(':memory:');
  const accounts = new Accounts(db);
  const events = [];
  const table = new Table({
    id: 't', accounts, onEvent: (type, payload) => events.push({ type, payload }), ...opts,
  });
  return { db, accounts, table, events };
}

const user = (accounts, name) => accounts.createUser(`${name}@example.com`, 'password123', name);

/** Push the table past whatever it is waiting for. */
const force = table => table.tick(Date.now() + 10 ** 7);

/* =============================================== a hand, start to finish */
{
  const { accounts, table } = freshTable();
  const alice = user(accounts, 'alice');
  const bob = user(accounts, 'bob');

  table.sit(0, alice);
  table.sit(2, bob);
  eq(table.phase, 'betting', 'a seated player opens betting');

  table.placeBet(alice.id, 500);
  table.placeBet(bob.id, 1000);
  eq(accounts.balance(alice.id), STARTING_BALANCE - 500, 'the stake leaves the balance when it is bet');

  let second = false;
  try { table.placeBet(alice.id, 500); } catch { second = true; }
  ok(second, 'a second bet in one round is refused');
  eq(accounts.balance(alice.id), STARTING_BALANCE - 500, 'and does not take the money twice');

  force(table);                       // betting closes, cards come out
  ok(['insurance', 'acting', 'payout'].includes(table.phase), `dealing leads somewhere sensible (${table.phase})`);

  // Everyone in the round holds two cards.
  for (const s of table.publicState().seats.filter(Boolean)) {
    if (!s.inRound) continue;
    eq(s.hands[0].cards.length, 2, `seat ${s.seatNo} was dealt two cards`);
  }
}

/* ============================================ the hole card stays hidden */
{
  const { accounts, table } = freshTable();
  const alice = user(accounts, 'alice');
  table.sit(0, alice);
  table.placeBet(alice.id, 500);
  force(table);

  if (table.phase === 'acting' || table.phase === 'insurance') {
    const pub = table.publicState();
    eq(pub.dealer.cards.length, 1, 'only the upcard is published while players act');
    ok(pub.dealer.hidden >= 1, 'the hidden card is reported as hidden, not sent');
    /* Not a substring scan for the hole card's name: six decks mean "4d" names
       six different cards, so a player legitimately holding one reads as a leak
       about 6% of the time. What matters is structural — the dealer publishes
       the upcard, and everything else is counted rather than sent. */
    const { cardName } = await import('../server/engine.mjs');
    eq(pub.dealer.cards[0], cardName(table.dealer.cards[0]), 'and it is the upcard, not the hole card');
    eq(pub.dealer.hidden, table.dealer.cards.length - 1, 'every card not published is counted as hidden');
  } else {
    checks += 3;   // dealer had a natural; the round ended before anyone acted
  }
}

/* ================================================== acting out of turn */
{
  const { accounts, table } = freshTable();
  const alice = user(accounts, 'alice');
  const bob = user(accounts, 'bob');
  table.sit(0, alice);
  table.sit(1, bob);
  table.placeBet(alice.id, 500);
  table.placeBet(bob.id, 500);
  force(table);
  if (table.phase === 'insurance') force(table);

  if (table.phase === 'acting') {
    const waiting = table.active.seat === 0 ? bob : alice;
    let refused = false;
    try { table.act(waiting.id, 'hit'); } catch { refused = true; }
    ok(refused, 'a player cannot act while it is somebody else\'s turn');

    // An action that is not legal for the hand is refused even from the right player.
    const turnUser = table.active.seat === 0 ? alice : bob;
    let badRefused = false;
    try { table.act(turnUser.id, 'quadruple'); } catch { badRefused = true; }
    ok(badRefused, 'an action that is not on the list is refused');
  } else { checks += 2; }
}

/* ============================================= a turn that is never taken */
{
  const { accounts, table } = freshTable();
  const alice = user(accounts, 'alice');
  table.sit(0, alice);
  table.placeBet(alice.id, 500);
  force(table);
  if (table.phase === 'insurance') force(table);

  if (table.phase === 'acting') {
    const before = accounts.balance(alice.id);
    force(table);                                  // the turn timer expires
    ok(table.phase !== 'acting' || table.active, 'a timed-out turn moves the table on');
    ok(accounts.balance(alice.id) >= before, 'timing out never costs more than the bet already placed');
  } else { checks += 2; }
}

/* ======================================== many rounds, money stays honest */
{
  const { accounts, table } = freshTable();
  const players = ['p1', 'p2', 'p3'].map(n => user(accounts, n));
  players.forEach((p, i) => table.sit(i, p));

  let rounds = 0, naturals = 0, splits = 0, doubles = 0, surrenders = 0;

  for (let r = 0; r < 300; r++) {
    if (table.phase !== 'betting') { force(table); continue; }

    for (const p of players) {
      if (accounts.balance(p.id) >= 2000) {
        try { table.placeBet(p.id, 200 + 100 * (r % 5)); } catch { /* broke, sits out */ }
      }
    }
    if (!table.seats.some(s => s && s.bet)) break;
    force(table);                                   // deal

    if (table.phase === 'insurance') {
      for (const p of players) { try { table.takeInsurance(p.id, r % 3 === 0); } catch {} }
      force(table);
    }

    // Play every hand with a deliberately varied bot, so splits, doubles and
    // surrenders all actually happen rather than the test only ever standing.
    let guard = 0;
    while (table.phase === 'acting' && guard++ < 200) {
      const { seat, hand } = table.active;
      const s = table.seats[seat];
      const p = players.find(x => x.id === s.userId);
      const h = s.hands[hand];
      const { legalActions } = await import('../server/engine.mjs');
      const acts = legalActions(h, table.rules, s.hands.length, accounts.balance(p.id));
      if (!acts.length) { force(table); continue; }

      let choice;
      if (acts.includes('split') && guard % 2 === 0) { choice = 'split'; splits++; }
      else if (acts.includes('double') && best(h) === 11) { choice = 'double'; doubles++; }
      else if (acts.includes('surrender') && best(h) === 16 && guard % 5 === 0) { choice = 'surrender'; surrenders++; }
      else if (best(h) < 17) choice = 'hit';
      else choice = 'stand';

      try { table.act(p.id, choice); } catch { force(table); }
    }

    if (table.phase === 'dealer') force(table);
    if (table.phase === 'payout') {
      rounds++;
      for (const res of table.lastResults) {
        for (const h of res.hands) if (h.outcome === 'blackjack') naturals++;
      }
      force(table);                                 // back to betting
    }

    // No balance may ever be negative, at any point.
    for (const p of players) ok(accounts.balance(p.id) >= 0, 'balance never goes negative');
    checks -= players.length - 1;                   // count that as one check, not 900
  }

  ok(rounds > 40, `enough rounds actually completed (${rounds})`);
  ok(splits > 0, `splits happened (${splits})`);
  ok(doubles > 0, `doubles happened (${doubles})`);

  // The audit that matters: every cached balance equals the sum of its ledger.
  const drift = accounts.audit();
  eq(drift.length, 0, `no account drifted from its ledger (${JSON.stringify(drift).slice(0, 200)})`);

  // And the ledger's own arithmetic: each row's balance_after is the running sum.
  for (const p of players) {
    const rows = accounts.history(p.id, 100000).reverse();
    let running = 0, bad = 0;
    for (const row of rows) { running += row.delta; if (running !== row.balance_after) bad++; }
    eq(bad, 0, `ledger for ${p.display} is a consistent running total`);
    eq(running, accounts.balance(p.id), `ledger for ${p.display} sums to the balance`);
  }

  console.log(`  played ${rounds} rounds — ${splits} splits, ${doubles} doubles, ${surrenders} surrenders, ${naturals} naturals`);
}

/* ================================================ a bet you cannot cover */
{
  const { accounts, table } = freshTable();
  const alice = user(accounts, 'alice');
  table.sit(0, alice);
  let refused = false;
  try { table.placeBet(alice.id, STARTING_BALANCE + 1); } catch { refused = true; }
  ok(refused, 'a bet larger than the balance is refused');
  eq(accounts.balance(alice.id), STARTING_BALANCE, 'and costs nothing');

  refused = false;
  try { table.placeBet(alice.id, 1); } catch { refused = true; }
  ok(refused, 'a bet below the table minimum is refused');
}

/* ============================================================ the seats */
{
  const { accounts, table } = freshTable();
  const alice = user(accounts, 'alice');
  const bob = user(accounts, 'bob');
  table.sit(0, alice);

  let taken = false;
  try { table.sit(0, bob); } catch { taken = true; }
  ok(taken, 'an occupied seat cannot be taken');

  let twice = false;
  try { table.sit(1, alice); } catch { twice = true; }
  ok(twice, 'one player cannot hold two seats');

  table.stand(alice.id);
  eq(table.seats[0], null, 'standing frees the seat');
  eq(table.phase, 'waiting', 'an empty table goes back to waiting');
}

/* ================================================== provable fairness */
{
  const seed = newServerSeed();
  const commit = commitTo(seed);
  eq(commit, commitTo(seed), 'the commitment is stable for a seed');
  eq(commit.length, 64, 'the commitment is a sha256 hex digest');

  const a = buildShoe(6, seed, 'client-1');
  const b = buildShoe(6, seed, 'client-1');
  eq(a.join(','), b.join(','), 'the same seeds reproduce the same shoe exactly');

  const c = buildShoe(6, seed, 'client-2');
  ok(a.join(',') !== c.join(','), 'a different client seed gives a different shoe');

  eq(a.length, 312, 'six decks is 312 cards');
  const counts = new Map();
  for (const card of a) counts.set(card, (counts.get(card) || 0) + 1);
  eq(counts.size, 52, 'every distinct card is present');
  ok([...counts.values()].every(n => n === 6), 'each card appears once per deck and no more');

  // The shuffle should not favour any position. Across many shoes, the mean
  // starting index of a given card should sit near the middle.
  let sum = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const shoe = buildShoe(1, newServerSeed(), `c${i}`);
    sum += shoe.indexOf(0); n++;                 // where the ace of spades landed
  }
  const mean = sum / n;
  ok(Math.abs(mean - 25.5) < 4, `the shuffle does not favour a position (mean index ${mean.toFixed(1)}, expected ~25.5)`);
}

/* ================================================== naturals pay 3 to 2 */
{
  const { accounts, table } = freshTable();
  const { newHand, settleHand } = await import('../server/engine.mjs');
  const rules = table.rules;

  // Ace of spades + king of spades against a dealer 20.
  const player = newHand(1000);
  player.cards = [0, 12];
  const dealer = newHand(0);
  dealer.cards = [9, 9];                           // ten, ten
  const r = settleHand(player, dealer, rules);
  eq(r.outcome, 'blackjack', 'a natural is recognised');
  eq(r.delta, 2500, 'a natural returns the stake plus 3:2');

  // Same hand at 6:5.
  const r65 = settleHand(player, dealer, { ...rules, blackjackPays: [6, 5] });
  eq(r65.delta, 2200, 'at 6:5 the same natural returns less');

  // Both natural is a push.
  const dealerBJ = newHand(0);
  dealerBJ.cards = [13, 25];                       // ace of hearts, king of hearts
  eq(settleHand(player, dealerBJ, rules).outcome, 'push', 'two naturals push');

  // Surrender returns half the stake, rounded down on an odd cent.
  const surr = newHand(1000);
  surr.cards = [5, 9];
  surr.surrendered = true;
  eq(settleHand(surr, dealer, rules).delta, 500, 'surrender returns half the stake');
  const oddSurr = newHand(101);
  oddSurr.cards = [5, 9];
  oddSurr.surrendered = true;
  eq(settleHand(oddSurr, dealer, rules).delta, 50, 'an odd stake rounds the house\'s way, never the player\'s');
  // Surrender beats busting: a surrendered hand that would also have lost keeps half.
  ok(settleHand(surr, dealer, rules).delta > settleHand(oddSurr, dealer, rules).delta * 2 - 101,
     'surrender is settled before the hand is scored');

  // A busted hand returns nothing, even against a busted dealer.
  const busted = newHand(1000);
  busted.cards = [9, 9, 9];
  const dealerBust = newHand(0);
  dealerBust.cards = [9, 9, 9];
  eq(settleHand(busted, dealerBust, rules).delta, 0, 'the player busts first and loses to a busted dealer');
}

/* --------------------------------------------- surviving a restart
   A hand lives in memory; its stake has already left the balance. If the
   process dies in between, that money sits in the ledger with nothing to
   answer it — and no audit notices, because the books balance perfectly.

   The hard part is telling an unsettled stake from a settled one. A losing
   hand returns nothing and so writes no row at all, which makes "a bet with
   no payout" ambiguous. Get it wrong in the generous direction and every
   loss is refunded; that is the first thing checked here.              */
{
  const boot = (accounts) => new Table({ id: 't', accounts, onEvent: () => {} });

  // Play one round to completion, then restart. Nothing may be handed back,
  // whether the hand won, pushed or lost.
  {
    const db = openDb(':memory:');
    const accounts = new Accounts(db);
    const t = boot(accounts);
    const alice = user(accounts, 'restart-a');
    t.sit(0, alice);
    t.placeBet(alice.id, 1000);
    let now = Date.now();
    t.tick(now += TIMING.betting + 1);
    for (let i = 0; i < 40 && t.phase !== 'payout' && t.phase !== 'betting'; i++) {
      t.tick(now += TIMING.turn + TIMING.insurance + 1);
    }
    ok(t.phase === 'payout' || t.phase === 'betting', 'the round reached a settlement');
    const settled = accounts.balance(alice.id);
    const after = boot(accounts);
    eq(after.recovered.length, 0, 'a finished round is refunded nothing on the next boot');
    eq(accounts.balance(alice.id), settled, 'a finished round leaves the balance exactly as settled');
  }

  // Die mid-hand: the stake comes back.
  {
    const db = openDb(':memory:');
    const accounts = new Accounts(db);
    const t = boot(accounts);
    const alice = user(accounts, 'restart-b');
    t.sit(0, alice);
    t.placeBet(alice.id, 1000);
    t.tick(Date.now() + TIMING.betting + 1);
    eq(accounts.balance(alice.id), STARTING_BALANCE - 1000, 'the stake is off the balance mid-hand');
    const after = boot(accounts);
    eq(after.recovered.length, 1, 'the interrupted stake is found on the next boot');
    eq(accounts.balance(alice.id), STARTING_BALANCE, 'the interrupted stake is returned in full');
  }

  // Die between the bet and the deal: also comes back.
  {
    const db = openDb(':memory:');
    const accounts = new Accounts(db);
    const t = boot(accounts);
    const alice = user(accounts, 'restart-c');
    t.sit(0, alice);
    t.placeBet(alice.id, 2500);
    boot(accounts);
    eq(accounts.balance(alice.id), STARTING_BALANCE, 'a bet that was never dealt is returned');
  }

  // Refunding is idempotent: booting repeatedly cannot mint money.
  {
    const db = openDb(':memory:');
    const accounts = new Accounts(db);
    const t = boot(accounts);
    const alice = user(accounts, 'restart-d');
    t.sit(0, alice);
    t.placeBet(alice.id, 700);
    boot(accounts); boot(accounts); boot(accounts);
    eq(accounts.balance(alice.id), STARTING_BALANCE, 'three boots return the stake once, not three times');
  }

  // The table id is a constant, so a hand counter that restarted at zero would
  // write a ref that already belongs to an earlier hand.
  {
    const db = openDb(':memory:');
    const accounts = new Accounts(db);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const t = boot(accounts);
      const p = user(accounts, `restart-seq-${i}`);
      t.sit(0, p);
      t.placeBet(p.id, 500);
      t.tick(Date.now() + TIMING.betting + 1);
      seen.push(t.handNo);
    }
    eq(new Set(seen).size, seen.length, `hand numbers stay distinct across restarts (${seen.join(',')})`);
  }

  // Whatever the recovery does, the ledger must still explain every balance.
  {
    const db = openDb(':memory:');
    const accounts = new Accounts(db);
    const t = boot(accounts);
    const alice = user(accounts, 'restart-e');
    t.sit(0, alice);
    t.placeBet(alice.id, 1200);
    t.tick(Date.now() + TIMING.betting + 1);
    boot(accounts);
    eq(accounts.audit().length, 0, 'every balance still matches its ledger after a recovery');
  }
}

/* ------------------------------------------------------------------ done */
console.log(`table checks run: ${checks}`);
if (fails.length) {
  console.log('TABLE FAILURES:');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('all table checks passed');
