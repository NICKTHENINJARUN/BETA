import { chromium, APP_URL } from './harness.mjs';
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await p.goto(APP_URL);
await p.waitForTimeout(400);

const res = await p.evaluate(() => {
  const B = window.__BJ;
  const R = (o) => Object.assign({h17:true,enhc:false,das:true,surrender:true,peek:true,decks:6,bjPays:1.5}, o||{});
  const C = rs => rs.map(r => B.card(r, '♠'));
  const play = (hand, up, rules, ctx) => B.basicPlay(C(hand), B.card(up,'♣'), R(rules), ctx);
  const cases = [
    // [hand, upcard, rules, expected, label]
    [['10','6'],'10',{},'SURRENDER','16v10 H17+LS'],
    [['10','6'],'10',{surrender:false},'HIT','16v10 no surrender'],
    [['10','6'],'9',{},'SURRENDER','16v9'],
    [['10','6'],'7',{},'HIT','16v7'],
    [['10','6'],'6',{},'STAND','16v6'],
    [['10','5'],'10',{},'SURRENDER','15v10'],
    [['10','5'],'9',{surrender:false},'HIT','15v9 noLS'],
    [['10','2'],'2',{},'HIT','12v2'],
    [['10','2'],'4',{},'STAND','12v4'],
    [['10','2'],'3',{},'HIT','12v3'],
    [['10','3'],'2',{},'STAND','13v2'],
    [['7','4'],'A',{h17:true},'DOUBLE','11vA H17'],
    [['7','4'],'A',{h17:false},'HIT','11vA S17'],
    [['7','4'],'10',{},'DOUBLE','11v10'],
    [['6','4'],'10',{},'HIT','10v10'],
    [['6','4'],'9',{},'DOUBLE','10v9'],
    [['5','4'],'2',{},'HIT','9v2'],
    [['5','4'],'3',{},'DOUBLE','9v3'],
    [['5','4'],'7',{},'HIT','9v7'],
    [['10','7'],'A',{h17:true},'SURRENDER','17vA H17+LS'],
    [['10','7'],'A',{h17:false},'STAND','17vA S17'],
    [['A','7'],'3',{},'DOUBLE','A7v3'],
    [['A','7'],'7',{},'STAND','A7v7'],
    [['A','7'],'9',{},'HIT','A7v9'],
    [['A','7'],'2',{h17:true},'DOUBLE','A7v2 H17'],
    [['A','7'],'2',{h17:false},'STAND','A7v2 S17'],
    [['A','8'],'6',{h17:true},'DOUBLE','A8v6 H17'],
    [['A','8'],'6',{h17:false},'STAND','A8v6 S17'],
    [['A','2'],'5',{},'DOUBLE','A2v5'],
    [['A','2'],'4',{},'HIT','A2v4'],
    [['A','4'],'4',{},'DOUBLE','A4v4'],
    [['A','9'],'6',{},'STAND','A9v6'],
    [['8','8'],'10',{},'SPLIT','88v10'],
    [['8','8'],'A',{h17:true},'SURRENDER','88vA H17+LS'],
    [['8','8'],'A',{h17:true,surrender:false},'SPLIT','88vA noLS'],
    [['A','A'],'10',{},'SPLIT','AAv10'],
    [['9','9'],'7',{},'STAND','99v7'],
    [['9','9'],'9',{},'SPLIT','99v9'],
    [['9','9'],'A',{},'STAND','99vA'],
    [['10','10'],'6',{},'STAND','TTv6'],
    [['5','5'],'6',{},'DOUBLE','55v6 = hard 10'],
    [['5','5'],'10',{},'HIT','55v10'],
    [['4','4'],'5',{das:true},'SPLIT','44v5 DAS'],
    [['4','4'],'5',{das:false},'HIT','44v5 noDAS'],
    [['6','6'],'2',{das:true},'SPLIT','66v2 DAS'],
    [['6','6'],'2',{das:false},'HIT','66v2 noDAS'],
    [['2','2'],'3',{das:true},'SPLIT','22v3 DAS'],
    [['7','7'],'8',{},'HIT','77v8'],
    [['7','7'],'7',{},'SPLIT','77v7'],
    // ENHC adjustments
    [['7','4'],'10',{enhc:true},'HIT','ENHC 11v10'],
    [['8','8'],'10',{enhc:true},'HIT','ENHC 88v10'],
    [['A','A'],'A',{enhc:true},'HIT','ENHC AAvA'],
    [['8','8'],'6',{enhc:true},'SPLIT','ENHC 88v6 still splits'],
    // fallbacks when an option is unavailable
    [['7','4'],'10',{},'HIT','11v10 no double available', {canDouble:false,canSplit:false,canSurrender:false}],
    [['8','8'],'10',{},'HIT','88v10 cannot split -> hard 16 vs 10', {canDouble:true,canSplit:false,canSurrender:false}],
    [['A','A'],'6',{},'HIT','AA cannot split -> soft 12 hit', {canDouble:true,canSplit:false,canSurrender:false}],
    [['A','6'],'4',{},'DOUBLE','A6v4'],
    [['10','9'],'10',{},'STAND','19v10'],
  ];
  const fails = [];
  for (const [hand, up, rules, exp, label, ctx] of cases) {
    const got = play(hand, up, rules, ctx);
    if (got !== exp) fails.push(`${label}: expected ${exp}, got ${got}`);
  }
  // index plays
  const ix = id => B.INDICES.find(e => e.id === id);
  const idxCases = [
    ['16v10', 0, 'STAND'], ['16v10', -1, 'HIT'],
    ['12v3', 2, 'STAND'], ['12v3', 1, 'HIT'],
    ['ins', 3, 'INSURE'], ['ins', 2, 'NO INSURANCE'],
    ['13v2', -2, 'HIT'], ['13v2', 0, 'STAND'],
    ['11vA', 1, 'DOUBLE'],
  ];
  for (const [id, tc, exp] of idxCases) {
    const got = B.indexPlay(ix(id), tc, R());
    if (got !== exp) fails.push(`index ${id} @${tc}: expected ${exp}, got ${got}`);
  }
  // shoe integrity
  const shoe = B.Shoe(6);
  const counts = {};
  shoe.cards.forEach(c => counts[c.rank] = (counts[c.rank]||0)+1);
  if (shoe.cards.length !== 312) fails.push('shoe size ' + shoe.cards.length);
  if (counts['A'] !== 24) fails.push('ace count ' + counts['A']);
  const tagSum = shoe.cards.reduce((s,c)=>s+({A:-1,'2':1,'3':1,'4':1,'5':1,'6':1,'7':0,'8':0,'9':0,'10':-1,J:-1,Q:-1,K:-1})[c.rank],0);
  if (tagSum !== 0) fails.push('hi-lo tags do not balance: ' + tagSum);
  // dealing the whole shoe should drive the running count back to 0
  const s2 = B.Shoe(6);
  while (s2.cards.length) s2.expose(s2.draw());
  if (s2.rc() !== 0) fails.push('full-shoe running count ' + s2.rc());
  // house edge sanity
  const he = B.houseEdge({decks:6,h17:false,das:true,surrender:true,bjPays:1.5,enhc:false});
  if (Math.abs(he - 0.40) > 0.001) fails.push('base edge ' + he);
  const he65 = B.houseEdge({decks:6,h17:false,das:true,surrender:true,bjPays:1.2,enhc:false});
  if (he65 <= he) fails.push('6:5 should be worse');
  return { fails, total: cases.length + idxCases.length };
});

console.log(`engine checks run: ${res.total}`);
if (res.fails.length) { console.log('FAILURES:'); res.fails.forEach(f => console.log('  ✗ ' + f)); }
else console.log('all engine checks passed');
if (errs.length) { console.log('CONSOLE ERRORS:'); errs.forEach(e => console.log('  ' + e)); }
await b.close();
process.exit(res.fails.length || errs.length ? 1 : 0);
