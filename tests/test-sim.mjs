// Validates the Monte Carlo engine against published blackjack figures.
//
// Two things make this test meaningful rather than decorative:
//   1. House edge is measured per INITIAL bet, which is how published figures
//      are defined. Dividing by total action (doubles and splits included)
//      deflates every number by about 13%.
//   2. Every assertion carries the simulation's own standard error, so the
//      bands are as tight as the sample size honestly allows and the test
//      does not flake.
import { chromium, APP_URL } from './harness.mjs';

const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await p.goto(APP_URL);
await p.waitForTimeout(300);

const ROUNDS = 15_000_000;

const out = await p.evaluate(async (ROUNDS) => {
  const B = window.__BJ, engine = B.SimEngine();
  const flat = bet => Array.from({ length: 17 }, () => ({ bet, hands: 1 }));

  function run(o, rounds) {
    const rules = Object.assign(
      { decks: 6, h17: false, enhc: false, peek: true, das: true, surrender: true, bjPays: 1.5 },
      o.rules || {});
    const t = B.compileTables(rules);
    const cfg = Object.assign({
      decks: rules.decks, penetration: 0.75, h17: rules.h17, enhc: !!rules.enhc,
      peek: rules.peek !== false, das: rules.das, surrender: rules.surrender,
      es10: false, rsa: false, maxHands: 4, bjPays: rules.bjPays, players: 1,
      useIdx: false, insure: false, dealerAlways: false,
      spread: flat(10), bankroll: 1e12, seed: 20260918,
      roundsPerPath: rounds, samplePoints: 4, paths: 1
    }, o.cfg || {}, { hard: t.hard, soft: t.soft, pair: t.pair, idx: t.idx });
    const st = engine.init(cfg); engine.step(st, 1);
    const r = engine.result(st);
    const n = r.rounds, mean = r.net / n;
    const variance = r.sumSq / n - mean * mean;
    const avgInitial = r.initial / n;
    const dTot = r.dOut.reduce((a, c) => a + c, 0);
    return {
      edge: -mean / avgInitial * 100,                             // % of initial bet
      se: Math.sqrt(variance / n) / avgInitial * 100,             // 1 standard error
      adv: r.net / r.initial * 100,
      rounds: n, action: r.wagered / r.initial,
      dealer: r.dOut.map(v => v / dTot * 100),
      shuffles: r.shuffles
    };
  }

  const t0 = performance.now();
  const base   = run({}, ROUNDS);
  const h17    = run({ rules: { h17: true } }, ROUNDS);
  const noDas  = run({ rules: { das: false } }, ROUNDS);
  const noSurr = run({ rules: { surrender: false } }, ROUNDS);
  const bj65   = run({ rules: { bjPays: 1.2 } }, ROUNDS);
  const dd     = run({ rules: { decks: 2 } }, ROUNDS);
  const dealerRun = run({ cfg: { dealerAlways: true } }, 4_000_000);
  const elapsed = (performance.now() - t0) / 1000;

  // A counter in a good game: 6 deck, H17, 80% penetration, 1-12 spread, indices on.
  const ramp = { '-6': 1, '-5': 1, '-4': 1, '-3': 1, '-2': 1, '-1': 1, '0': 1, '1': 1,
                 '2': 2, '3': 4, '4': 8, '5': 12, '6': 12, '7': 12, '8': 12, '9': 12, '10': 12 };
  const spread = [];
  for (let tc = -6; tc <= 10; tc++) spread.push({ bet: 25 * ramp[tc], hands: 1 });
  const counter = run({
    rules: { h17: true },
    cfg: { penetration: 0.8, players: 3, useIdx: true, insure: true, spread }
  }, ROUNDS);
  const noIdx = run({
    rules: { h17: true },
    cfg: { penetration: 0.8, players: 3, useIdx: false, insure: false, spread }
  }, ROUNDS);
  const flatInGoodGame = run({
    rules: { h17: true },
    cfg: { penetration: 0.8, players: 3, useIdx: false, insure: false, spread: flat(25) }
  }, ROUNDS);

  // cross-check the published-constants estimator used in the Table Log
  const estimated = B.houseEdge({ decks: 6, h17: true, das: true, surrender: true, bjPays: 1.5, enhc: false });

  return { base, h17, noDas, noSurr, bj65, dd, dealerDist: dealerRun.dealer, counter, noIdx, flatInGoodGame,
           estimated, elapsed, perSec: Math.round(ROUNDS * 8 / elapsed) };
}, ROUNDS);

const fails = [];
const chk = (c, m) => { if (!c) fails.push(m); };
const pp = n => (n >= 0 ? '+' : '') + n.toFixed(3);
/** measured value must sit within 3 standard errors of the published figure, plus a small allowance */
function near(label, measured, se, expected, slack) {
  const tol = 3 * se + slack;
  chk(Math.abs(measured - expected) <= tol,
      `${label}: measured ${pp(measured)} vs published ${pp(expected)} (tolerance ±${tol.toFixed(3)})`);
}
const dse = (a, b) => Math.sqrt(a.se * a.se + b.se * b.se);

console.log(`throughput ~${out.perSec.toLocaleString()} rounds/sec, ${out.elapsed.toFixed(1)}s total\n`);
console.log(`6D S17 DAS LS 3:2   house edge ${out.base.edge.toFixed(3)}% ±${out.base.se.toFixed(3)} (per initial bet)`);
console.log(`  dealer hits soft 17      ${pp(out.h17.edge - out.base.edge)} pp   (published +0.22)`);
console.log(`  no double after split    ${pp(out.noDas.edge - out.base.edge)} pp   (published +0.14)`);
console.log(`  no late surrender        ${pp(out.noSurr.edge - out.base.edge)} pp   (published +0.08)`);
console.log(`  blackjack pays 6:5       ${pp(out.bj65.edge - out.base.edge)} pp   (published +1.39)`);
console.log(`  two decks instead of six ${pp(out.dd.edge - out.base.edge)} pp   (published -0.19, played on the 4-8 deck chart)`);
console.log(`\nTable Log estimator says ${out.estimated.toFixed(2)}% for 6D H17 DAS LS; simulation says ${out.h17.edge.toFixed(3)}%`);

const LBL = ['17', '18', '19', '20', '21', 'BJ', 'bust'];
// the dealer's blackjacks are settled at the peek and never reach the draw loop,
// so published figures are rescaled by the 4.83% of hands that end there
const PUBLISHED = { '17': 14.58, '18': 13.81, '19': 13.48, '20': 17.58, '21': 7.36, 'bust': 28.32 };
const share = 1 - 0.0483;
console.log('\ndealer final totals vs published (blackjacks excluded on both sides):');
for (let i = 0; i < 7; i++) {
  if (LBL[i] === 'BJ') continue;
  const mine = out.dealerDist[i], ref = PUBLISHED[LBL[i]] / share;
  console.log(`  ${LBL[i].padEnd(4)} ${mine.toFixed(2)}%   published ${ref.toFixed(2)}%`);
  chk(Math.abs(mine - ref) < 0.5, `dealer ${LBL[i]}: ${mine.toFixed(2)}% vs ${ref.toFixed(2)}%`);
}

console.log(`\ncounter, 1-12 spread + indices : ${pp(out.counter.adv)}% of initial bets`);
console.log(`  same spread, no indices      : ${pp(out.noIdx.adv)}%`);
console.log(`  flat betting the same game   : ${pp(out.flatInGoodGame.adv)}%`);

near('H17', out.h17.edge - out.base.edge, dse(out.h17, out.base), 0.22, 0.05);
near('no DAS', out.noDas.edge - out.base.edge, dse(out.noDas, out.base), 0.14, 0.05);
near('no surrender', out.noSurr.edge - out.base.edge, dse(out.noSurr, out.base), 0.08, 0.06);
near('6:5 blackjack', out.bj65.edge - out.base.edge, dse(out.bj65, out.base), 1.39, 0.08);
near('two decks', out.dd.edge - out.base.edge, dse(out.dd, out.base), -0.19, 0.08);
chk(out.base.edge > 0.25 && out.base.edge < 0.55, `base edge ${out.base.edge.toFixed(3)}% outside 0.25-0.55%`);
chk(Math.abs(out.estimated - out.h17.edge) < 0.15, `estimator ${out.estimated.toFixed(2)}% disagrees with simulation ${out.h17.edge.toFixed(3)}%`);
// counting has to actually beat the game, indices have to add to it, flat betting must not
chk(out.counter.adv > 0.3 && out.counter.adv < 2.5, `counter advantage ${pp(out.counter.adv)}% implausible`);
chk(out.counter.adv > out.noIdx.adv, `indices should add value (${pp(out.counter.adv)} vs ${pp(out.noIdx.adv)})`);
chk(out.flatInGoodGame.adv < 0, `flat betting should lose (${pp(out.flatInGoodGame.adv)}%)`);
chk(out.counter.shuffles > 1000, 'shoe should reshuffle regularly');

console.log(fails.length ? '\nSIM FAILURES:' : '\nsimulation matches published expectations');
fails.forEach(x => console.log('  x ' + x));
if (errs.length) { console.log('ERRORS:'); errs.forEach(e => console.log('  ' + e)); }
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
