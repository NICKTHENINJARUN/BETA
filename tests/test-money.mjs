import { chromium, APP_URL } from './harness.mjs';
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await p.goto(APP_URL);
await p.waitForTimeout(300);

const report = await p.evaluate(async () => {
  const B = window.__BJ, S = () => B.sim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const click = sel => { const el = document.querySelector(sel); if (el && !el.disabled && !el.closest('[hidden]')) { el.click(); return true; } return false; };
  // open the simulator
  document.querySelector('[data-mode="simulation"]').click();
  await sleep(50);
  B.state.sim.bank = 100000; B.state.sim.start = 100000;

  const problems = [];
  let handsChecked = 0, splitsSeen = 0, doublesSeen = 0, bjSeen = 0, insSeen = 0, surrSeen = 0;

  // independent settlement calculator, written from the rules rather than from the app's code
  const settle = (hands, dealer, ins, rules) => {
    const info = cs => B.handInfo(cs);
    const d = info(dealer);
    const dBJ = dealer.length === 2 && d.total === 21;
    let ret = 0;
    if (ins) ret += dBJ ? ins * 3 : 0;
    for (const h of hands) {
      const ph = info(h.cards);
      const pBJ = hands.length === 1 && h.cards.length === 2 && ph.total === 21;
      if (h.surrendered) ret += h.bet / 2;
      else if (ph.total > 21) ret += 0;
      else if (dBJ && !pBJ) ret += 0;
      else if (pBJ && dBJ) ret += h.bet;
      else if (pBJ) ret += h.bet + h.bet * rules.bjPays;
      else if (d.total > 21 || ph.total > d.total) ret += h.bet * 2;
      else if (ph.total < d.total) ret += 0;
      else ret += h.bet;
    }
    return ret;
  };

  for (let hand = 0; hand < 220; hand++) {
    const bankBefore = B.state.sim.bank;
    document.querySelector('#simBet').value = '25';
    click('#simDeal');
    await sleep(0);
    let stakeTracked = 25, guard = 0;
    while (S().phase === 'play' || S().phase === 'insurance') {
      if (++guard > 40) { problems.push('hand did not terminate'); break; }
      if (S().phase === 'insurance') {
        const take = Math.random() < .5;
        if (take) insSeen++;
        click(`#simInsure [data-i="${take ? 'yes' : 'no'}"]`);
        await sleep(0);
        continue;
      }
      const enabled = [...document.querySelectorAll('#simActions [data-s]')].filter(x => !x.disabled).map(x => x.dataset.s);
      if (!enabled.length) break;
      // bias towards exercising split / double / surrender
      const weighted = enabled.flatMap(a => a === 'SPLIT' ? [a,a,a,a] : a === 'DOUBLE' ? [a,a] : a === 'SURRENDER' ? [a] : [a]);
      const pickAct = weighted[Math.floor(Math.random() * weighted.length)];
      const before = S().hands.length;
      if (pickAct === 'DOUBLE') { doublesSeen++; stakeTracked += S().hands[S().active].bet; }
      if (pickAct === 'SPLIT') { splitsSeen++; stakeTracked += S().hands[S().active].bet; }
      if (pickAct === 'SURRENDER') surrSeen++;
      click(`#simActions [data-s="${pickAct}"]`);
      await sleep(0);
    }
    if (S().phase !== 'done') { problems.push('phase ' + S().phase + ' after play'); break; }
    const s = S();
    const ins = s.ins || 0;
    const staked = s.hands.reduce((t, h) => t + h.bet, 0) + ins;
    const returned = settle(s.hands, s.dealer, ins, B.state.rules);
    const expected = bankBefore - staked + returned;
    if (Math.abs(B.state.sim.bank - expected) > 1e-9) {
      problems.push(`hand ${hand}: bank ${B.state.sim.bank} expected ${expected} (hands=${s.hands.length}, dealer=${s.dealer.map(c=>c.rank)}, ins=${ins})`);
      if (problems.length > 4) break;
    }
    if (s.hands.some(h => h.cards.length === 2 && B.handInfo(h.cards).total === 21 && s.hands.length === 1)) bjSeen++;
    handsChecked++;
    // hole card must never be counted while face down
    if (s.dealer.some(c => c.hidden)) problems.push('hole card still hidden after settle');
  }

  // counting integrity: running count must equal the Hi-Lo sum of exposed cards only
  const HI = {A:-1,'2':1,'3':1,'4':1,'5':1,'6':1,'7':0,'8':0,'9':0,'10':-1,J:-1,Q:-1,K:-1};
  const shoe = S().shoe;
  const manual = shoe.seen.reduce((t, c) => t + HI[c.rank], 0);
  if (manual !== shoe.rc()) problems.push(`running count ${shoe.rc()} != manual ${manual}`);

  // during play the face-down hole card must be excluded from the count
  document.querySelector('#simBet').value = '25';
  click('#simDeal'); await sleep(0);
  let holeOK = true;
  if (!B.state.rules.enhc) {
    const s = S();
    if (s.phase === 'play' || s.phase === 'insurance') {
      const exposedNow = s.shoe.seen.length;
      const hidden = s.dealer.filter(c => c.hidden).length;
      if (hidden !== 1) holeOK = false;
      if (s.shoe.seen.includes(s.dealer[1])) holeOK = false;
    }
  }
  if (!holeOK) problems.push('hole card leaked into the count before it was turned up');

  return { problems, handsChecked, splitsSeen, doublesSeen, bjSeen, insSeen, surrSeen, finalBank: B.state.sim.bank };
});

console.log(`hands verified: ${report.handsChecked} (splits ${report.splitsSeen}, doubles ${report.doublesSeen}, blackjacks ${report.bjSeen}, insurance ${report.insSeen}, surrenders ${report.surrSeen})`);
console.log(`final bankroll: ${report.finalBank}`);
if (report.problems.length) { console.log('PROBLEMS:'); report.problems.forEach(x => console.log('  ✗ ' + x)); }
else console.log('bankroll accounting matches an independent settlement on every hand');
if (errs.length) { console.log('ERRORS:'); errs.forEach(e => console.log('  ' + e)); }
await b.close();
process.exit(report.problems.length || errs.length ? 1 : 0);
