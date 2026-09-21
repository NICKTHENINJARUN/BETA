/* Blackjack rules for the server.
 *
 * The client never sees this run. Everything that decides an outcome — the
 * shoe, the order of the cards, the dealer's hole card, who won — happens
 * here, and the client is told only what a player at a real table could see.
 * That is the whole difference between this and the trainer in index.html,
 * where the browser holds the shoe because nothing is at stake.
 *
 * Money never appears in this file as a float. Bets and payouts are integer
 * cents throughout; 0.1 + 0.2 is not 0.3 and a ledger that drifts by a cent
 * per hand is a ledger nobody can audit.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

/* ------------------------------------------------------------------ cards */
/* A card is an integer 0..51 within a deck: rank = c % 13, suit = (c / 13).
   Rank 0 is an ace, 9..12 are ten/jack/queen/king. Keeping suits rather than
   collapsing to values costs nothing and means the table can show a real card
   and a verifier can reproduce the exact shoe. */
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['s', 'h', 'd', 'c'];

export const rankOf = c => c % 13;
export const suitOf = c => Math.floor(c / 13) % 4;
/** Ace counts 1 here; `best` adds the 10 back when it fits. */
export const valueOf = c => Math.min(rankOf(c) + 1, 10);
export const cardName = c => RANKS[rankOf(c)] + SUITS[suitOf(c)];

/* ------------------------------------------------------- provable fairness */
/* Before a shoe is dealt the server publishes sha256(serverSeed). The shuffle
 * is driven by HMAC(serverSeed, clientSeed:nonce), and when the shoe is retired
 * the server publishes serverSeed itself. Anyone can then recompute the shoe
 * and check it against the hands they were dealt, and can see that the commit
 * published beforehand matches the seed revealed afterwards.
 *
 * This is not decoration. It is the difference between "trust us" and a claim
 * a player can check, and it is the sort of thing a regulator asks to see.
 */
export const commitTo = serverSeed => createHash('sha256').update(serverSeed).digest('hex');
export const newServerSeed = () => randomBytes(32).toString('hex');

/** A uniform stream of bytes from the seeds, used to drive the shuffle. */
function* byteStream(serverSeed, clientSeed) {
  for (let round = 0; ; round++) {
    const block = createHmac('sha256', serverSeed).update(`${clientSeed}:${round}`).digest();
    for (const b of block) yield b;
  }
}

/** A random integer in [0, max) with no modulo bias — rejection sampling. */
function below(stream, max) {
  if (max <= 1) return 0;
  // Enough bytes to cover max, then reject anything in the ragged tail.
  const bytes = Math.ceil(Math.log2(max) / 8) || 1;
  const span = 256 ** bytes;
  const limit = span - (span % max);
  for (;;) {
    let n = 0;
    for (let i = 0; i < bytes; i++) n = n * 256 + stream.next().value;
    if (n < limit) return n % max;
  }
}

/**
 * A shoe of `decks` decks, shuffled from the seeds.
 * Deterministic: the same seeds always give the same order, which is what
 * makes the fairness claim checkable.
 */
export function buildShoe(decks, serverSeed, clientSeed) {
  const shoe = [];
  for (let d = 0; d < decks; d++) for (let c = 0; c < 52; c++) shoe.push(c);
  const stream = byteStream(serverSeed, clientSeed);
  // Fisher-Yates, back to front.
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = below(stream, i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

/* ------------------------------------------------------------------ hands */
export const newHand = (bet = 0) => ({
  cards: [], bet, done: false, doubled: false, surrendered: false,
  fromSplit: false, fromSplitAce: false,
});

/** Total with every ace as 1. */
export const hard = h => h.cards.reduce((t, c) => t + valueOf(c), 0);
/** The hand's actual value: the 10 comes back if an ace can carry it. */
export const best = h => {
  const t = hard(h);
  return (h.cards.some(c => rankOf(c) === 0) && t + 10 <= 21) ? t + 10 : t;
};
export const isSoft = h => h.cards.some(c => rankOf(c) === 0) && hard(h) + 10 <= 21;
export const isBust = h => hard(h) > 21;
export const isPair = h => h.cards.length === 2 && valueOf(h.cards[0]) === valueOf(h.cards[1]);
/** A natural is two cards only, and never after a split. */
export const isNatural = h => h.cards.length === 2 && !h.fromSplit && best(h) === 21;

/* ------------------------------------------------------- what a player may do */
/**
 * The legal actions for a hand, given the table rules and how many hands the
 * seat already holds. The client renders buttons from this, and the server
 * checks against it again when an action arrives — a client that asks to
 * double on a five-card hand is simply refused.
 */
export function legalActions(hand, rules, handCount, balanceCents) {
  if (hand.done || isBust(hand)) return [];
  const twoCards = hand.cards.length === 2;
  const canAfford = balanceCents >= hand.bet;
  const acts = ['hit', 'stand'];

  // Split aces get one card each and no more, anywhere.
  if (hand.fromSplitAce && !rules.hitSplitAces) return [];

  if (twoCards && canAfford && (!hand.fromSplit || rules.das)) acts.push('double');
  if (twoCards && isPair(hand) && handCount < rules.maxHands && canAfford) {
    // Re-splitting aces is its own rule; splitting them the first time is not.
    if (!(hand.fromSplitAce && !rules.resplitAces)) acts.push('split');
  }
  if (twoCards && !hand.fromSplit && rules.surrender) acts.push('surrender');
  return acts;
}

/* ----------------------------------------------------------------- dealer */
/**
 * Play the dealer out. Deterministic and rule-driven: the dealer has no
 * choices, which is exactly why this belongs on the server where nobody can
 * lean on it.
 */
export function playDealer(hand, drawCard, rules) {
  for (;;) {
    const t = best(hand);
    if (t > 21) return hand;
    if (t > 17) return hand;
    if (t === 17 && !(rules.h17 && isSoft(hand))) return hand;
    if (t < 17 || (t === 17 && rules.h17 && isSoft(hand))) hand.cards.push(drawCard());
    else return hand;
  }
}

/* ------------------------------------------------------------- settlement */
/**
 * What one hand is owed, in cents, as a change to the player's balance —
 * the bet having already been taken when it was placed.
 *
 * So a push returns the stake (+bet), a loss returns nothing (0), an even-money
 * win returns stake plus winnings (+2 × bet). Reporting it this way means the
 * ledger only ever adds, and the balance is the sum of its entries.
 */
export function settleHand(hand, dealer, rules) {
  const bet = hand.bet;
  if (hand.surrendered) return { delta: Math.floor(bet / 2), outcome: 'surrender' };
  if (isBust(hand)) return { delta: 0, outcome: 'bust' };

  const dealerBJ = isNatural(dealer);
  if (isNatural(hand)) {
    if (dealerBJ) return { delta: bet, outcome: 'push' };
    // 3:2 or 6:5, rounded down — the house keeps the fraction of a cent.
    const [num, den] = rules.blackjackPays;
    return { delta: bet + Math.floor(bet * num / den), outcome: 'blackjack' };
  }
  if (dealerBJ) return { delta: 0, outcome: 'lose' };

  const p = best(hand), d = best(dealer);
  if (isBust(dealer) || p > d) return { delta: bet * 2, outcome: 'win' };
  if (p === d) return { delta: bet, outcome: 'push' };
  return { delta: 0, outcome: 'lose' };
}

/** Insurance pays 2:1 and is settled separately from the hand itself. */
export function settleInsurance(insuranceCents, dealer) {
  return isNatural(dealer) ? insuranceCents * 3 : 0;
}

export const DEFAULT_RULES = {
  decks: 6,
  h17: true,                 // dealer hits soft 17
  das: true,                 // double after split
  surrender: true,           // late surrender
  peek: true,                // dealer checks for blackjack before players act
  maxHands: 4,               // hands per seat after splits
  resplitAces: false,
  hitSplitAces: false,
  blackjackPays: [3, 2],
  penetration: 0.75,
  minBet: 100,               // cents
  maxBet: 250000,           // $2,500 — a real high-limit table's ceiling
};
