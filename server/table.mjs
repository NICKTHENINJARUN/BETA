/* A multiplayer blackjack table.
 *
 * The table owns the shoe, the dealer and the clock. Clients send intents
 * ("bet 500", "hit") and are told what happened; they are never trusted to
 * say what a card is, whose turn it is, or what a hand is worth.
 *
 * Time is passed in rather than read. The table has deadlines and a `tick(now)`
 * that advances them, so the server can drive it from an interval and a test
 * can drive it instantly — a turn timer that only expires in real seconds is a
 * turn timer nobody tests.
 */
import {
  DEFAULT_RULES, newHand, best, isBust, isNatural, isPair, legalActions,
  playDealer, settleHand, settleInsurance, buildShoe, newServerSeed, commitTo,
  cardName, rankOf, valueOf,
} from './engine.mjs';

export const SEATS = 5;

/* How long each phase waits, in ms. */
export const TIMING = {
  betting: 15000,
  insurance: 10000,
  turn: 20000,
  payout: 4000,
};

export class Table {
  /**
   * @param {object}   opts
   * @param {string}   opts.id
   * @param {object}   opts.rules
   * @param {function} opts.onEvent  called with (type, payload) for broadcast
   * @param {object}   opts.accounts an Accounts instance, for bets and payouts
   */
  constructor({ id = 'main', rules = {}, onEvent = () => {}, accounts, clientSeed = 'table' } = {}) {
    this.id = id;
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.onEvent = onEvent;
    this.accounts = accounts;
    this.clientSeed = clientSeed;

    this.seats = Array.from({ length: SEATS }, () => null);
    this.phase = 'waiting';
    this.deadline = 0;
    this.dealer = newHand(0);
    this.handNo = 0;
    this.active = null;          // { seat, hand } whose turn it is
    this.lastResults = null;

    this.#newShoe();
  }

  /* ------------------------------------------------------------ the shoe */
  #newShoe() {
    // Reveal the seed that governed the shoe just finished, so anyone who
    // played it can recompute every card they saw.
    if (this.serverSeed) {
      this.onEvent('shoe.revealed', {
        serverSeed: this.serverSeed, clientSeed: this.clientSeed,
        commit: this.commit, decks: this.rules.decks,
      });
    }
    this.serverSeed = newServerSeed();
    this.commit = commitTo(this.serverSeed);
    this.shoe = buildShoe(this.rules.decks, this.serverSeed, this.clientSeed);
    this.pos = 0;
    this.cut = Math.floor(this.shoe.length * this.rules.penetration);
    this.onEvent('shoe.new', { commit: this.commit, decks: this.rules.decks });
  }

  #draw() {
    // A round can want more cards than sit in front of the cut, so the shoe
    // is replaced mid-round rather than run off the end.
    if (this.pos >= this.shoe.length) this.#newShoe();
    return this.shoe[this.pos++];
  }

  /* ----------------------------------------------------------- the seats */
  sit(seatNo, user) {
    if (seatNo < 0 || seatNo >= SEATS) throw new Error('no such seat');
    if (this.seats[seatNo]) throw new Error('that seat is taken');
    if (this.seats.some(s => s && s.userId === user.id)) throw new Error('you are already seated');

    this.seats[seatNo] = {
      userId: user.id, display: user.display, seatNo,
      bet: 0, hands: [], insurance: 0, activeHand: 0,
      inRound: false, lastAction: null,
    };
    this.onEvent('seat.taken', { seatNo, display: user.display });
    if (this.phase === 'waiting') this.#toBetting();
    return this.seats[seatNo];
  }

  stand(userId) {
    const i = this.seats.findIndex(s => s && s.userId === userId);
    if (i < 0) return;
    const seat = this.seats[i];
    // A bet already in front of a player is theirs to lose; leaving mid-round
    // does not refund it, exactly as at a table.
    this.seats[i] = null;
    this.onEvent('seat.left', { seatNo: i, display: seat.display });
    if (this.active && this.active.seat === i) this.#advanceTurn();
    if (!this.seats.some(Boolean)) { this.phase = 'waiting'; this.deadline = 0; }
  }

  seatOf(userId) { return this.seats.find(s => s && s.userId === userId) || null; }

  /* ---------------------------------------------------------- the phases */
  #toBetting() {
    this.phase = 'betting';
    this.deadline = Date.now() + TIMING.betting;
    this.dealer = newHand(0);
    this.active = null;
    for (const s of this.seats) {
      if (!s) continue;
      s.bet = 0; s.hands = []; s.insurance = 0; s.activeHand = 0; s.inRound = false;
    }
    // Retire the shoe between rounds once the cut card is behind us.
    if (this.pos >= this.cut) this.#newShoe();
    this.onEvent('phase', this.publicState());
  }

  placeBet(userId, cents) {
    if (this.phase !== 'betting') throw new Error('betting is closed');
    const seat = this.seatOf(userId);
    if (!seat) throw new Error('you are not seated');
    cents = Math.floor(Number(cents) || 0);
    if (cents < this.rules.minBet) throw new Error(`minimum bet is ${this.rules.minBet} cents`);
    if (cents > this.rules.maxBet) throw new Error(`maximum bet is ${this.rules.maxBet} cents`);
    if (seat.bet) throw new Error('you have already bet this round');

    // Taken now, not at settlement. The stake leaves the balance when it goes
    // on the table, which is what stops the same money being bet twice.
    this.accounts.post([{ userId, delta: -cents, reason: 'bet', ref: `${this.id}#${this.handNo + 1}` }]);
    seat.bet = cents;
    this.onEvent('bet', { seatNo: seat.seatNo, cents, balance: this.accounts.balance(userId) });
    return seat;
  }

  #deal() {
    const playing = this.seats.filter(s => s && s.bet > 0);
    if (!playing.length) { this.#toBetting(); return; }

    this.handNo++;
    this.phase = 'dealing';
    for (const s of playing) {
      s.inRound = true;
      s.hands = [newHand(s.bet)];
      s.activeHand = 0;
    }
    this.dealer = newHand(0);

    // Two rounds of one card each, players then dealer, as it is actually dealt.
    for (let r = 0; r < 2; r++) {
      for (const s of playing) s.hands[0].cards.push(this.#draw());
      this.dealer.cards.push(this.#draw());
    }

    this.onEvent('dealt', this.publicState());

    const up = this.dealer.cards[0];
    if (this.rules.peek && rankOf(up) === 0) { this.#toInsurance(); return; }
    // With a ten up the dealer peeks silently; nothing is offered, but a
    // natural ends the round before anyone acts.
    if (this.rules.peek && valueOf(up) === 10 && isNatural(this.dealer)) { this.#toPayout(); return; }
    this.#startTurns();
  }

  #toInsurance() {
    this.phase = 'insurance';
    this.deadline = Date.now() + TIMING.insurance;
    this.onEvent('phase', this.publicState());
  }

  takeInsurance(userId, take) {
    if (this.phase !== 'insurance') throw new Error('insurance is not open');
    const seat = this.seatOf(userId);
    if (!seat || !seat.inRound) throw new Error('you are not in this round');
    if (seat.insurance) throw new Error('you have already answered');
    if (!take) { seat.insurance = -1; return seat; }   // -1 marks "asked, declined"

    const cents = Math.floor(seat.bet / 2);
    this.accounts.post([{ userId, delta: -cents, reason: 'insurance', ref: `${this.id}#${this.handNo}` }]);
    seat.insurance = cents;
    this.onEvent('insurance', { seatNo: seat.seatNo, cents, balance: this.accounts.balance(userId) });
    return seat;
  }

  #closeInsurance() {
    if (isNatural(this.dealer)) { this.#toPayout(); return; }
    this.#startTurns();
  }

  #startTurns() {
    this.phase = 'acting';
    this.active = null;
    this.#advanceTurn();
  }

  /** Move to the next hand that still has a decision to make. */
  #advanceTurn() {
    let seatNo = this.active ? this.active.seat : -1;
    let handNo = this.active ? this.active.hand : 0;

    for (;;) {
      const seat = seatNo >= 0 ? this.seats[seatNo] : null;
      if (seat && seat.inRound && handNo + 1 < seat.hands.length) {
        handNo++;                                  // next hand of the same seat
      } else {
        seatNo++; handNo = 0;
        if (seatNo >= SEATS) { this.#toDealer(); return; }
      }
      const s = this.seats[seatNo];
      if (!s || !s.inRound || !s.hands[handNo]) continue;
      const h = s.hands[handNo];
      if (h.done || isBust(h)) continue;

      // A natural, or a split ace that has had its one card, needs no decision.
      if (isNatural(h)) { h.done = true; continue; }
      const acts = legalActions(h, this.rules, s.hands.length, this.accounts.balance(s.userId));
      if (!acts.length) { h.done = true; continue; }

      s.activeHand = handNo;
      this.active = { seat: seatNo, hand: handNo };
      this.deadline = Date.now() + TIMING.turn;
      this.onEvent('turn', { seatNo, hand: handNo, actions: acts, deadline: this.deadline, state: this.publicState() });
      return;
    }
  }

  act(userId, action) {
    if (this.phase !== 'acting') throw new Error('it is not time to act');
    const seat = this.seatOf(userId);
    if (!seat) throw new Error('you are not seated');
    if (!this.active || this.active.seat !== seat.seatNo) throw new Error('it is not your turn');

    const hand = seat.hands[this.active.hand];
    const acts = legalActions(hand, this.rules, seat.hands.length, this.accounts.balance(userId));
    if (!acts.includes(action)) throw new Error(`you cannot ${action} here`);

    switch (action) {
      case 'hit':
        hand.cards.push(this.#draw());
        if (isBust(hand) || best(hand) === 21) hand.done = true;
        break;

      case 'stand':
        hand.done = true;
        break;

      case 'double':
        this.accounts.post([{ userId, delta: -hand.bet, reason: 'double', ref: `${this.id}#${this.handNo}` }]);
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(this.#draw());
        hand.done = true;
        break;

      case 'surrender':
        hand.surrendered = true;
        hand.done = true;
        break;

      case 'split': {
        this.accounts.post([{ userId, delta: -hand.bet, reason: 'split', ref: `${this.id}#${this.handNo}` }]);
        const wasAces = rankOf(hand.cards[0]) === 0;
        const moved = hand.cards.pop();
        const second = newHand(hand.bet);
        second.fromSplit = true; second.fromSplitAce = wasAces;
        second.cards.push(moved);
        hand.fromSplit = true; hand.fromSplitAce = wasAces;
        // One card to each half straight away, as dealt at a table.
        hand.cards.push(this.#draw());
        second.cards.push(this.#draw());
        seat.hands.splice(this.active.hand + 1, 0, second);
        // Split aces are finished unless the rules say otherwise.
        if (wasAces && !this.rules.hitSplitAces) { hand.done = true; second.done = true; }
        break;
      }
    }

    seat.lastAction = action;
    this.onEvent('acted', { seatNo: seat.seatNo, hand: this.active.hand, action, state: this.publicState() });

    // Still this hand's turn if it can act again (hit that did not bust).
    if (!hand.done && !isBust(hand)) {
      const more = legalActions(hand, this.rules, seat.hands.length, this.accounts.balance(userId));
      if (more.length) {
        this.deadline = Date.now() + TIMING.turn;
        this.onEvent('turn', { seatNo: seat.seatNo, hand: this.active.hand, actions: more, deadline: this.deadline, state: this.publicState() });
        return;
      }
      hand.done = true;
    }
    this.#advanceTurn();
  }

  #toDealer() {
    this.phase = 'dealer';
    this.active = null;
    // The dealer only plays on if somebody can still be beaten.
    const live = this.seats.some(s => s && s.inRound &&
      s.hands.some(h => !isBust(h) && !h.surrendered));
    if (live) playDealer(this.dealer, () => this.#draw(), this.rules);
    this.onEvent('dealer', this.publicState());
    this.#toPayout();
  }

  #toPayout() {
    this.phase = 'payout';
    const entries = [];
    const results = [];

    for (const seat of this.seats) {
      if (!seat || !seat.inRound) continue;
      let total = 0;
      const hands = seat.hands.map((h, i) => {
        const r = settleHand(h, this.dealer, this.rules);
        total += r.delta;
        if (r.delta) entries.push({
          userId: seat.userId, delta: r.delta, reason: 'settle',
          ref: `${this.id}#${this.handNo}/${i}`,
        });
        return { hand: i, outcome: r.outcome, delta: r.delta, total: best(h), cards: h.cards.map(cardName) };
      });

      if (seat.insurance > 0) {
        const ins = settleInsurance(seat.insurance, this.dealer);
        total += ins;
        if (ins) entries.push({
          userId: seat.userId, delta: ins, reason: 'insurance-win', ref: `${this.id}#${this.handNo}`,
        });
      }
      // Staked is what left the balance: every hand's bet, plus insurance.
      const staked = seat.hands.reduce((t, h) => t + h.bet, 0) + Math.max(0, seat.insurance);
      results.push({ seatNo: seat.seatNo, display: seat.display, hands, staked, returned: total, net: total - staked });
    }

    if (entries.length) this.accounts.post(entries);
    for (const r of results) r.balance = this.accounts.balance(this.seats[r.seatNo].userId);

    this.lastResults = results;
    this.deadline = Date.now() + TIMING.payout;
    this.onEvent('payout', { handNo: this.handNo, dealer: this.#dealerPublic(true), results });
  }

  /* ------------------------------------------------------------- the clock */
  /** Advance anything whose deadline has passed. The server calls this on an
   *  interval; tests call it directly. */
  tick(now = Date.now()) {
    if (!this.deadline || now < this.deadline) return;
    switch (this.phase) {
      case 'betting':   this.deadline = 0; this.#deal(); break;
      case 'insurance': this.deadline = 0; this.#closeInsurance(); break;
      case 'acting':    this.#timeoutTurn(); break;
      case 'payout':    this.deadline = 0; this.#toBetting(); break;
    }
  }

  /** A player who says nothing stands. Never folds their hand, never bets more. */
  #timeoutTurn() {
    if (!this.active) { this.#advanceTurn(); return; }
    const seat = this.seats[this.active.seat];
    if (seat && seat.hands[this.active.hand]) {
      seat.hands[this.active.hand].done = true;
      this.onEvent('acted', { seatNo: seat.seatNo, hand: this.active.hand, action: 'stand', timedOut: true });
    }
    this.#advanceTurn();
  }

  /* -------------------------------------------------------- what is shown */
  #dealerPublic(reveal) {
    const show = reveal || this.phase === 'dealer' || this.phase === 'payout';
    const cards = show ? this.dealer.cards : this.dealer.cards.slice(0, 1);
    return {
      cards: cards.map(cardName),
      hidden: show ? 0 : Math.max(0, this.dealer.cards.length - 1),
      total: show ? best(this.dealer) : (this.dealer.cards.length ? valueOf(this.dealer.cards[0]) : 0),
    };
  }

  /**
   * The table as anyone at it may see it. The hole card is not in here until
   * the dealer turns it over — it is left out of the payload entirely rather
   * than sent and hidden by the client, which would put it in devtools.
   */
  publicState() {
    return {
      id: this.id,
      phase: this.phase,
      handNo: this.handNo,
      deadline: this.deadline,
      rules: this.rules,
      commit: this.commit,
      cardsLeft: this.shoe.length - this.pos,
      dealer: this.#dealerPublic(false),
      active: this.active,
      seats: this.seats.map((s, i) => s && ({
        seatNo: i,
        display: s.display,
        bet: s.bet,
        inRound: s.inRound,
        insurance: s.insurance > 0 ? s.insurance : 0,
        activeHand: s.activeHand,
        hands: s.hands.map(h => ({
          cards: h.cards.map(cardName),
          total: best(h),
          bust: isBust(h),
          done: h.done,
          doubled: h.doubled,
          surrendered: h.surrendered,
          pair: isPair(h),
          natural: isNatural(h),
          bet: h.bet,
        })),
      })),
    };
  }
}
