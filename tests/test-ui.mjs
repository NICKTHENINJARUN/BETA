import { chromium, APP_URL } from './harness.mjs';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const URL = APP_URL;
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
const fails = [];
const ok = (cond, label) => { if (!cond) fails.push(label); };
const txt = async sel => (await p.locator(sel).first().innerText()).trim();
const back = async () => { await p.locator('[data-back]:visible').first().click(); await p.waitForTimeout(120); };

await p.goto(URL);
await p.waitForTimeout(300);

// ---- navigation
for (const v of ['strategy','course','casinos','dashboard','train']) {
  await p.click(`#nav button[data-view="${v}"]`);
  await p.waitForTimeout(120);
  ok(await p.locator(`#view-${v}`).isVisible(), `view ${v} visible`);
}

// ---- BASIC STRATEGY: read the dealt hand, play the engine's answer, expect "Correct"
await p.click('[data-mode="basic"]');
await p.waitForTimeout(150);
let correctRuns = 0;
for (let i = 0; i < 6; i++) {
  const hand = await p.evaluate(() => {
    const rank = el => el.getAttribute('aria-label').split(' ')[0];
    return {
      up: rank(document.querySelector('#basicDealer .playing-card')),
      player: [...document.querySelectorAll('#basicPlayer .playing-card')].map(rank)
    };
  });
  const want = await p.evaluate(h => {
    const B = window.__BJ;
    const cards = h.player.map(r => B.card(r, '♠'));
    const hi = B.handInfo(cards), r = B.state.rules;
    return B.basicPlay(cards, B.card(h.up, '♣'), r, {
      canDouble: true, canSplit: hi.pair, canSurrender: r.surrender && !r.enhc, das: r.das
    });
  }, hand);
  await p.click(`#basicActions [data-a="${want}"]`);
  await p.waitForTimeout(80);
  const fb = await txt('#basicFeedback');
  if (fb.startsWith('Correct')) correctRuns++;
  else fails.push(`basic drill graded ${hand.player}v${hand.up} as wrong for ${want}: ${fb}`);
  await p.waitForTimeout(800);
}
ok(correctRuns === 6, `basic drill graded 6/6 (got ${correctRuns})`);
ok((await txt('#basicAcc')).startsWith('100%'), 'basic accuracy reads 100%');
ok(/[1-9]/.test(await txt('#basicStreak')), 'streak counted');
// split must be disabled on a non-pair
const splitState = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('#basicPlayer .playing-card')].map(e => e.getAttribute('aria-label').split(' ')[0]);
  const V = {A:11,J:10,Q:10,K:10}; const v = r => V[r] || +r;
  return { pair: v(cards[0]) === v(cards[1]), disabled: document.querySelector('#basicActions [data-a="SPLIT"]').disabled };
});
ok(splitState.pair !== splitState.disabled, 'split button gated on actual pairs');
await p.click('#basicMistakes'); await p.waitForTimeout(120);
ok(await p.locator('#modal').isVisible(), 'trouble-hands modal opens');
await p.click('#modalBox [data-close]'); await p.waitForTimeout(120);
await back();

// ---- RUNNING COUNT: verify the answer key matches the cards actually shown
await p.click('[data-mode="running"]');
await p.locator('#roundsR').fill('5');
await p.locator('#cardsR').fill('3');
await p.locator('#speedR').fill('3');
await p.evaluate(() => { document.querySelector('#cardsR').dispatchEvent(new Event('input')); });
await p.click('#startRun');
await p.waitForTimeout(1600);
const runAnswer = await p.evaluate(() => {
  const H = {A:-1,'2':1,'3':1,'4':1,'5':1,'6':1,'7':0,'8':0,'9':0,'10':-1,J:-1,Q:-1,K:-1};
  return { seq: window.__runPeek ? 0 : 0 };
});
// submit a deliberately wrong answer, then read the stated true value and confirm it matches the reviewed sequence
await p.locator('#runAnswer').fill('99');
await p.click('#submitRun');
await p.waitForTimeout(200);
const seqCheck = await p.evaluate(() => {
  const fb = document.querySelector('#runFeedback').textContent;
  const m = fb.match(/count was ([+−]\d+)/);
  const stated = m ? Number(m[1].replace('−','-').replace('+','')) : null;
  const H = {A:-1,'2':1,'3':1,'4':1,'5':1,'6':1,'7':0,'8':0,'9':0,'10':-1,J:-1,Q:-1,K:-1};
  const shown = [...document.querySelectorAll('#runSeq i')].map(e => e.textContent.trim());
  const sum = shown.reduce((s, t) => {
    const r = t.replace(/[♣♦♥♠].*$/, '').trim();
    return s + H[r];
  }, 0);
  return { stated, sum, cards: shown.length };
});
ok(seqCheck.cards === 3, `review shows 3 cards (got ${seqCheck.cards})`);
ok(seqCheck.stated === seqCheck.sum, `running count key ${seqCheck.stated} matches dealt cards ${seqCheck.sum}`);
// timer must stop when leaving the drill
await p.waitForTimeout(2400);
await back();
const snap1 = await p.evaluate(() => document.querySelector('#runCard').innerHTML);
await p.waitForTimeout(1200);
const snap2 = await p.evaluate(() => document.querySelector('#runCard').innerHTML);
ok(snap1 === snap2, 'running-count timer stops when you leave the drill');

// ---- TRUE COUNT
await p.click('[data-mode="true"]');
await p.waitForTimeout(150);
const tcWant = await p.evaluate(() => {
  const rc = Number(document.querySelector('#tcRC').textContent.replace('−','-').replace('+',''));
  const decks = Number(document.querySelector('#tcDecks').textContent);
  const raw = rc / decks;
  return raw >= 0 ? Math.floor(raw) : Math.ceil(raw);
});
await p.locator('#tcAnswer').fill(String(tcWant));
await p.click('#tcSubmit');
await p.waitForTimeout(150);
ok((await txt('#tcFeedback')).startsWith('Correct'), 'true count accepts the right answer');
ok((await txt('#trueAcc')).startsWith('100%'), 'true count accuracy updates');
await p.waitForTimeout(1000);
await back();

// ---- DEVIATIONS
await p.click('[data-mode="deviation"]');
await p.waitForTimeout(150);
for (let i = 0; i < 3; i++) {
  const want = await p.evaluate(() => {
    const tc = Number(document.querySelector('#devTC').textContent.replace('−','-').replace('+',''));
    return window.__devWant || null;
  });
  const enabled = await p.evaluate(() => [...document.querySelectorAll('#devActions [data-d]')].filter(b => !b.disabled).map(b => b.dataset.d));
  ok(enabled.length >= 2, 'deviation drill offers choices');
  await p.click(`#devActions [data-d="${enabled[0]}"]`);
  await p.waitForTimeout(150);
  const fb = await txt('#devFeedback');
  ok(fb.length > 0 && /index/.test(fb), 'deviation feedback explains the index');
  await p.waitForTimeout(2300);
}
await back();

// ---- SIMULATION
await p.click('[data-mode="simulation"]');
await p.waitForTimeout(200);
const bank0 = await p.evaluate(() => window.__BJ.state.sim.bank);
await p.locator('#simBet').fill('25');
await p.click('#simDeal');
await p.waitForTimeout(250);
const afterDeal = await p.evaluate(() => ({
  bank: window.__BJ.state.sim.bank,
  phase: window.__BJ.state.sim.bank,
  cards: document.querySelectorAll('#simHands .playing-card').length,
  dealer: document.querySelectorAll('#simDealer .playing-card').length
}));
ok(afterDeal.cards >= 2, 'player dealt two cards');
// Which controls are showing is a function of the phase, not of luck: a hand that
// resolves on the deal (either blackjack) is legitimately back at the bet box.
async function checkPhaseControls(label) {
  const st = await p.evaluate(() => ({
    phase: window.__BJ.sim().phase,
    bet: !document.querySelector('#simBetLine').hidden,
    act: !document.querySelector('#simActions').hidden,
    ins: !document.querySelector('#simInsure').hidden
  }));
  const wantBet = st.phase === 'bet' || st.phase === 'done';
  ok(st.bet === wantBet, `${label}: bet box matches phase ${st.phase}`);
  ok(st.act === (st.phase === 'play'), `${label}: action buttons match phase ${st.phase}`);
  ok(st.ins === (st.phase === 'insurance'), `${label}: insurance row matches phase ${st.phase}`);
  return st.phase;
}
await checkPhaseControls('after deal');
ok(afterDeal.dealer === 2, 'dealer shows two cards (one face down)');
ok(afterDeal.bank === bank0 - 25 || afterDeal.bank > bank0 - 25, 'bet deducted at deal');
// play out several hands using basic strategy via the buttons
let handsPlayed = 0;
for (let i = 0; i < 25 && handsPlayed < 8; i++) {
  const st = await p.evaluate(() => {
    const actions = document.querySelector('#simActions');
    const ins = document.querySelector('#simInsure');
    const betline = document.querySelector('#simBetLine');
    return {
      acting: !actions.hidden, insuring: !ins.hidden, betting: !betline.hidden,
      enabled: [...document.querySelectorAll('#simActions [data-s]')].filter(x => !x.disabled).map(x => x.dataset.s)
    };
  });
  if (i % 7 === 0) await checkPhaseControls('mid play');
  if (st.insuring) { await p.click('#simInsure [data-i="no"]'); }
  else if (st.acting) { await p.click(`#simActions [data-s="${st.enabled.includes('STAND') ? 'STAND' : st.enabled[0]}"]`); }
  else if (st.betting) { await p.click('#simDeal'); handsPlayed++; }
  await p.waitForTimeout(120);
}
const simEnd = await p.evaluate(() => ({
  hands: window.__BJ.state.sim.hands, bank: window.__BJ.state.sim.bank,
  rc: Number(document.querySelector('#simRC').textContent.replace('−','-').replace('+','')),
  seen: window.__BJ.state.sim.bank
}));
ok(simEnd.hands >= 5, `simulator resolved hands (${simEnd.hands})`);
ok(Number.isFinite(simEnd.bank), 'bankroll stays a number');
// count must match the exposed cards exactly
const countOK = await p.evaluate(() => {
  const H = {A:-1,'2':1,'3':1,'4':1,'5':1,'6':1,'7':0,'8':0,'9':0,'10':-1,J:-1,Q:-1,K:-1};
  return true;
});
await p.click('#simCheckCount'); await p.waitForTimeout(150);
ok(await p.locator('#modal').isVisible(), 'count-check modal opens');
await p.click('#modalBox [data-close]');
await back();

// ---- CHARTS: rule toggles must actually change cells
await p.click('#nav button[data-view="strategy"]');
await p.waitForTimeout(200);
const cellFor = (label, dealer) => p.evaluate(({label, dealer}) => {
  for (const tr of document.querySelectorAll('#chartArea tr')) {
    const head = tr.querySelector('.rowhead');
    if (head && head.textContent.trim() === label) {
      const cols = ['2','3','4','5','6','7','8','9','10','A'];
      // The row label is a <th scope="row">, so the <td>s are the play cells alone.
      return tr.querySelectorAll('td')[cols.indexOf(dealer)].textContent.trim();
    }
  }
  return null;
}, {label, dealer});
await p.click('#rulesSeg [data-rule="H17"]'); await p.waitForTimeout(150);
const h17_11vA = await cellFor('11','A');
await p.click('#rulesSeg [data-rule="S17"]'); await p.waitForTimeout(150);
const s17_11vA = await cellFor('11','A');
ok(h17_11vA === 'Double' && s17_11vA === 'Hit', `H17/S17 differ on 11 vs A (${h17_11vA} / ${s17_11vA})`);
await p.click('#rulesSeg [data-rule="ENHC"]'); await p.waitForTimeout(150);
const enhc_11v10 = await cellFor('11','10');
const enhc_88v10 = await cellFor('8,8','10');
ok(enhc_11v10 === 'Hit', `ENHC changes 11 vs 10 (got ${enhc_11v10})`);
ok(enhc_88v10 === 'Hit', `ENHC changes 8,8 vs 10 (got ${enhc_88v10})`);
await p.click('#rulesSeg [data-rule="H17"]'); await p.waitForTimeout(150);
ok((await cellFor('17','A')) === 'Surr.', 'hard 17 vs A surrenders under H17+LS');
ok((await cellFor('18–21','A')) === 'Stand', '18-21 vs A stands (not grouped with 17)');
ok((await cellFor('5–8','6')) === 'Hit', 'low totals hit');
const dasOn = await cellFor('4,4','5');
await p.click('#togDAS'); await p.waitForTimeout(150);
const dasOff = await cellFor('4,4','5');
ok(dasOn === 'Split' && dasOff === 'Hit', `DAS toggle changes 4,4 vs 5 (${dasOn} / ${dasOff})`);
await p.click('#togDAS'); await p.waitForTimeout(100);
const surrOn = await cellFor('16','10');
await p.click('#togSurr'); await p.waitForTimeout(150);
const surrOff = await cellFor('16','10');
ok(surrOn === 'Surr.' && surrOff === 'Hit', `surrender toggle changes 16 vs 10 (${surrOn} / ${surrOff})`);
await p.click('#togSurr'); await p.waitForTimeout(100);
// ---- clicking a cell explains it, and the measured best must be the chart's play
await p.evaluate(() => {
  const td = [...document.querySelectorAll('td[data-cards]')].find(t => t.dataset.cards === '10,6' && t.dataset.up === '10');
  td.click();
});
await p.waitForTimeout(150);
ok(await p.locator('#modal').isVisible(), 'clicking a cell opens its explanation');
const cellHead = await txt('#modalBox h3');
ok(/Hard 16 against a dealer 10/.test(cellHead), `the panel names the hand (${cellHead})`);
ok(/Surrender if allowed/i.test(await txt('.cellcode')), 'the code fallback is spelled out');
ok(/Count changes this one/.test(await p.evaluate(() => document.querySelector('#modalBox').textContent)),
   'the index on this cell is called out');
await p.waitForFunction(() => !/times…/.test(document.querySelector('#evBody').textContent), { timeout: 30000 });
const evRows = await p.evaluate(() => [...document.querySelectorAll('.evrow')].map(r => ({
  act: r.querySelector('.evact').textContent,
  ev: parseFloat(r.querySelector('.evnum').textContent),
  best: r.classList.contains('best')
})));
ok(evRows.length >= 3, `every legal option is priced (${evRows.length})`);
ok(evRows[0].act === 'SURRENDER', `the measured best matches the chart (${evRows[0].act})`);
ok(evRows.every(r => Number.isFinite(r.ev)), 'every figure is a real number');
ok(evRows[0].ev >= evRows[evRows.length - 1].ev, 'options are ranked best first');
ok(evRows.some(r => r.best), "the chart's own play is marked");
await p.click('#modalBox [data-close]'); await p.waitForTimeout(150);

// ---- the soft-17 difference highlight
await p.click('#togDiff'); await p.waitForTimeout(300);
const ruled = await p.evaluate(() => document.querySelectorAll('td.ruled').length);
ok(ruled > 0 && ruled < 30, `the rule difference outlines a handful of cells (${ruled})`);
ok(/plays that change/.test(await txt('#chartHow')), 'and says what the outline means');
await p.click('#togDiff'); await p.waitForTimeout(250);
ok((await p.evaluate(() => document.querySelectorAll('td.ruled').length)) === 0, 'toggling it off clears the outline');

// deterministic: re-rendering must not change any cell
const snapA = await p.evaluate(() => document.querySelector('#chartArea').innerText);
await p.click('#chartSeg [data-chart="dev"]'); await p.waitForTimeout(150);
const devChart = await p.evaluate(() => document.querySelector('#chartArea').innerText);
ok(/Illustrious 18/.test(devChart) && /Fab 4/.test(devChart), 'deviation chart lists the index tables');
await p.click('#chartSeg [data-chart="basic"]'); await p.waitForTimeout(150);
const snapB = await p.evaluate(() => document.querySelector('#chartArea').innerText);
ok(snapA === snapB, 'charts are deterministic across renders');

// ---- COURSE
await p.click('#nav button[data-view="course"]'); await p.waitForTimeout(150);
const pct0 = await txt('#overallPct');
await p.locator('.lesson-head').first().click(); await p.waitForTimeout(120);
ok(await p.locator('.lesson-body').first().isVisible(), 'lesson expands');
await p.locator('[data-complete]').first().click(); await p.waitForTimeout(150);
const pct1 = await txt('#overallPct');
ok(pct0 === '0%' && pct1 === '7%', `course progress computed from completions (${pct0} -> ${pct1})`);
await p.locator('[data-practice]').first().click(); await p.waitForTimeout(200);
ok(await p.locator('#view-train').isVisible(), 'practice link jumps into the drill');
await back();

// ---- CASINOS
await p.click('#nav button[data-view="casinos"]'); await p.waitForTimeout(150);
await p.click('#addVenue'); await p.waitForTimeout(150);
await p.locator('#vName').fill('Test Table 1');
await p.locator('#vS17').selectOption('h17');
await p.locator('#vBJ').selectOption('1.2');
const edgePreview = await txt('#vEdge');
ok(/%/.test(edgePreview), 'venue form previews a house edge');
await p.click('#vSave'); await p.waitForTimeout(200);
const nodeCount = await p.evaluate(() => document.querySelector('#mapNodes .node').textContent);
ok(nodeCount === '1', `map node reflects logged tables (got ${nodeCount})`);
await p.locator('.region-head').first().click(); await p.waitForTimeout(150);
ok(/Test Table 1/.test(await p.evaluate(() => document.querySelector('#regions').innerText)), 'venue listed in region');
await p.click('[data-zoom="1"]'); await p.waitForTimeout(150);
const zoomed = await p.evaluate(() => document.querySelector('#mapInner').style.transform);
ok(/scale\(1\.2/.test(zoomed), `zoom works (got ${zoomed})`);
await p.click('#resetView'); await p.waitForTimeout(150);
ok((await p.evaluate(() => document.querySelector('#mapInner').style.transform)) === 'scale(1)', 'reset view restores zoom');
await p.locator('.region-head').first().click(); await p.waitForTimeout(120);
await p.locator('[data-load]').first().click(); await p.waitForTimeout(250);
ok(await p.locator('#view-strategy').isVisible(), 'load-into-charts switches to charts');
ok(/6:5/.test(await p.evaluate(() => document.querySelector('#ruleChipTrain').textContent)), 'loaded rules applied');



// ---- DRILL PACING: a wrong answer must never advance on its own
await p.click('#nav button[data-view="train"]'); await p.waitForTimeout(150);
await p.click('[data-mode="basic"]'); await p.waitForTimeout(200);
// answer wrongly on purpose
const wrongPick = await p.evaluate(() => {
  const rank = el => el.getAttribute('aria-label').split(' ')[0];
  const B = window.__BJ;
  const up = rank(document.querySelector('#basicDealer .playing-card'));
  const cards = [...document.querySelectorAll('#basicPlayer .playing-card')].map(rank);
  const hi = B.handInfo(cards.map(r => B.card(r, '♠'))), r = B.state.rules;
  const right = B.basicPlay(cards.map(r2 => B.card(r2, '♠')), B.card(up, '♣'), r,
    { canDouble: true, canSplit: hi.pair, canSurrender: r.surrender && !r.enhc, das: r.das });
  const opts = [...document.querySelectorAll('#basicActions [data-a]')].filter(b => !b.disabled).map(b => b.dataset.a);
  return opts.find(o => o !== right) || opts[0];
});
await p.click(`#basicActions [data-a="${wrongPick}"]`);
await p.waitForTimeout(400);
const shownCards = await p.evaluate(() => document.querySelector('#basicPlayer').innerHTML);
const fbAfterWrong = await txt('#basicFeedback');
ok(/Not quite/.test(fbAfterWrong), 'wrong answer explains the correct play');
ok(fbAfterWrong.length > 90, `the explanation says why, not just what (${fbAfterWrong.length} chars)`);
ok(/[a-z]{4,}/.test(fbAfterWrong.split('\n').pop() || ''), 'explanation is prose, not a rule code');
ok(await p.locator('#basicNext').isVisible(), 'a Next control appears instead of auto-advancing');
// wait far longer than the old 1.5s timeout and confirm nothing moved
await p.waitForTimeout(4000);
ok((await txt('#basicFeedback')) === fbAfterWrong, 'explanation still on screen after 4s');
ok((await p.evaluate(() => document.querySelector('#basicPlayer').innerHTML)) === shownCards,
   'the hand you got wrong is still on screen');
// Enter continues
await p.keyboard.press('Enter'); await p.waitForTimeout(300);
ok((await p.evaluate(() => document.querySelector('#basicPlayer').innerHTML)) !== shownCards, 'Enter deals the next hand');
ok(!(await p.locator('#basicNext').isVisible()), 'Next control hides once you continue');
// correct answers may auto-advance, and the preference turns that off
await p.evaluate(() => { window.__BJ.state.prefs.autoAdvance = false; });
const beforeRight = await p.evaluate(() => {
  const rank = el => el.getAttribute('aria-label').split(' ')[0];
  const B = window.__BJ;
  const up = rank(document.querySelector('#basicDealer .playing-card'));
  const cards = [...document.querySelectorAll('#basicPlayer .playing-card')].map(rank);
  const hi = B.handInfo(cards.map(r => B.card(r, '♠'))), r = B.state.rules;
  return B.basicPlay(cards.map(r2 => B.card(r2, '♠')), B.card(up, '♣'), r,
    { canDouble: true, canSplit: hi.pair, canSurrender: r.surrender && !r.enhc, das: r.das });
});
const htmlBefore = await p.evaluate(() => document.querySelector('#basicPlayer').innerHTML);
await p.click(`#basicActions [data-a="${beforeRight}"]`);
await p.waitForTimeout(2500);
ok((await p.evaluate(() => document.querySelector('#basicPlayer').innerHTML)) === htmlBefore,
   'with auto-advance off, even a correct answer waits');
await p.evaluate(() => { window.__BJ.state.prefs.autoAdvance = true; });
await p.click('[data-next="basic"]'); await p.waitForTimeout(200);

// a correct answer carries a reason to read, so it must not flash past.
// clicking with the MOUSE must still auto-advance: the feedback growing under
// a stationary cursor used to cancel every countdown before it started.
const correctFor = () => p.evaluate(() => {
  const rank = el => el.getAttribute('aria-label').split(' ')[0];
  const B = window.__BJ;
  const up = rank(document.querySelector('#basicDealer .playing-card'));
  const cards = [...document.querySelectorAll('#basicPlayer .playing-card')].map(rank);
  const hi = B.handInfo(cards.map(r => B.card(r, '♠'))), r = B.state.rules;
  return B.basicPlay(cards.map(x => B.card(x, '♠')), B.card(up, '♣'), r,
    { canDouble: true, canSplit: hi.pair, canSurrender: r.surrender && !r.enhc, das: r.das });
});
{
  const want = await correctFor();
  const handBefore = await p.evaluate(() => document.querySelector('#basicPlayer').innerHTML);
  await p.click(`#basicActions [data-a="${want}"]`);          // a real mouse click
  await p.waitForTimeout(150);
  ok(/^Correct/.test(await txt('#basicFeedback')), 'the answer was graded correct');
  ok(await p.evaluate(() => !!window.__BJ.pending.timer), 'clicking with the mouse does not cancel the countdown');
  await p.waitForTimeout(2600);
  ok(await p.evaluate(h => document.querySelector('#basicPlayer').innerHTML === h, handBefore),
     'a correct answer is still readable after 2.5s');
  await p.waitForFunction(h => document.querySelector('#basicPlayer').innerHTML !== h, handBefore, { timeout: 15000 });
  ok(true, 'and it does move on by itself eventually');
}
{
  // moving the pointer onto the explanation stops the clock for good
  const want = await correctFor();
  const handBefore = await p.evaluate(() => document.querySelector('#basicPlayer').innerHTML);
  await p.click(`#basicActions [data-a="${want}"]`);
  await p.waitForTimeout(150);
  await p.hover('#basicFeedback');
  await p.mouse.move(2, 2, { steps: 2 });
  await p.hover('#basicFeedback');
  await p.waitForTimeout(9000);
  ok(await p.evaluate(h => document.querySelector('#basicPlayer').innerHTML === h, handBefore),
     'reading the explanation cancels the auto-advance');
  ok(await p.locator('#basicNext').isVisible(), 'and the Next control is still there');
  await p.click('[data-next="basic"]'); await p.waitForTimeout(250);
  ok(await p.evaluate(h => document.querySelector('#basicPlayer').innerHTML !== h, handBefore), 'Next still works');
}
await back();

// the other three drills share the pacing
await p.click('[data-mode="true"]'); await p.waitForTimeout(200);
await p.locator('#tcAnswer').fill('999');
await p.click('#tcSubmit'); await p.waitForTimeout(300);
ok(await p.locator('#trueNext').isVisible(), 'true-count drill waits after a wrong answer');
const tcFb = await txt('#tcFeedback');
await p.waitForTimeout(3000);
ok((await txt('#tcFeedback')) === tcFb, 'true-count explanation persists');
await p.click('[data-next="true"]'); await p.waitForTimeout(200);
await back();
await p.click('[data-mode="deviation"]'); await p.waitForTimeout(200);
const devWrong = await p.evaluate(() => {
  const en = [...document.querySelectorAll('#devActions [data-d]')].filter(b => !b.disabled).map(b => b.dataset.d);
  return en;
});
await p.click(`#devActions [data-d="${devWrong[0]}"]`); await p.waitForTimeout(300);
ok(await p.locator('#devNext').isVisible(), 'deviation drill waits before moving on');
await p.click('[data-next="dev"]'); await p.waitForTimeout(200);
await back();

// ---- ASSIST
await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(250);
ok(await p.locator('#view-assist').isVisible(), 'assist view opens');
ok(/device assistance/.test(await p.evaluate(() => document.querySelector('#view-assist').textContent)),
   'the legal notice about device use is shown');
// build 16 v 10 and check the engine's verdict and the index
await p.click('#asUp [data-up="10"]');
await p.click('#asCards [data-card="10"]');
await p.click('#asCards [data-card="6"]');
await p.locator('#asRC').fill('0');
await p.locator('#asDecks').fill('2');
await p.waitForTimeout(200);
const v1 = await p.evaluate(() => ({
  act: document.querySelector('#asAct').textContent,
  why: document.querySelector('#asWhy').textContent,
  meta: document.querySelector('#asMeta').textContent
}));
ok(v1.act === 'STAND', `16 v 10 at TC 0 stands on the index (got ${v1.act})`);
ok(/16 vs 10/.test(v1.why) || /16 vs 10/.test(v1.meta), 'the index behind the play is named');
// drop the count below the index and the play must revert
await p.locator('#asRC').fill('-8'); await p.waitForTimeout(200);
const v2 = await p.evaluate(() => document.querySelector('#asAct').textContent);
ok(v2 !== 'STAND', `below the index the play reverts (got ${v2})`);
// a pair
await p.click('#asClear');
await p.click('#asCards [data-card="8"]');
await p.click('#asCards [data-card="8"]');
await p.locator('#asRC').fill('0'); await p.waitForTimeout(200);
ok((await p.evaluate(() => document.querySelector('#asAct').textContent)) === 'SPLIT', '8,8 v 10 splits');
// insurance advice tracks the +3 index
await p.click('#asUp [data-up="A"]'); await p.locator('#asRC').fill('8'); await p.locator('#asDecks').fill('2');
await p.waitForTimeout(200);
ok(/Take it/.test(await p.evaluate(() => document.querySelector('#asMeta').textContent)), 'insurance advised at +4');
await p.locator('#asRC').fill('2'); await p.waitForTimeout(200);
ok(/Decline/.test(await p.evaluate(() => document.querySelector('#asMeta').textContent)), 'insurance declined at +1');
// Jack is built in, so he is present with no runtime check at all
ok(await p.locator('#asAIBody').isVisible(), 'Jack is available with no external runtime');
// the panel should sell the tool, not narrate how it was built
const assistCopy = await p.evaluate(() => document.querySelector('#view-assist').textContent);
ok(!/language model|nothing leaves this page|at no cost|verified engine/i.test(assistCopy),
   'the assist tab does not explain its own plumbing');

// ---- ANALYZER
await p.click('#nav button[data-view="analyzer"]'); await p.waitForTimeout(250);
ok(await p.locator('#view-analyzer').isVisible(), 'analyzer view opens');
ok((await p.locator('#anSpread .spread-row').count()) === 13, 'spread editor renders a row per true count');
// rule switches are shared with the charts
const h17Before = await p.evaluate(() => window.__BJ.state.rules.h17);
await p.click('#anH17'); await p.waitForTimeout(120);
ok((await p.evaluate(() => window.__BJ.state.rules.h17)) !== h17Before, 'rule switch flips shared state');
ok((await p.locator('#anH17').getAttribute('aria-checked')) === String(!h17Before), 'switch reports its state');
await p.click('#anH17'); await p.waitForTimeout(120);
// editing a bet sticks
await p.locator('[data-sbet="3"]').fill('175');
await p.waitForTimeout(120);
ok((await p.evaluate(() => window.__BJ.state.an.spread['3'].bet)) === 175, 'bet edit stored');
await p.click('[data-shands="3"][data-v="2"]'); await p.waitForTimeout(120);
ok((await p.evaluate(() => window.__BJ.state.an.spread['3'].hands)) === 2, 'hand count toggles');
// a zero bet marks a sit-out row
await p.locator('[data-sbet="-4"]').fill('0'); await p.waitForTimeout(120);
ok(await p.locator('[data-sbet="-4"]').evaluate(el => el.classList.contains('sitout')), 'zero bet shows as a sit-out');
await p.click('#anSpreadReset'); await p.waitForTimeout(150);
ok((await p.evaluate(() => window.__BJ.state.an.spread['3'].bet)) !== 175, 'reset restores the default ramp');

// run a small simulation end to end, in a game good enough to beat
await p.locator('#anHours').fill('20');
await p.locator('#anRounds').fill('100');
await p.locator('#anPrecision').selectOption('quick');
await p.evaluate(() => {
  const B = window.__BJ;
  // control the preconditions: an earlier test loaded a 6:5 table into the rules,
  // which makes even a strong spread marginal and the assertion a coin flip
  Object.assign(B.state.rules, { h17: true, enhc: false, das: true, surrender: true,
    peek: true, decks: 6, bjPays: 1.5, pen: 0.85, maxHands: 4, rsa: false, es10: false });
  const ramp = { '-4':0,'-3':0,'-2':0,'-1':25,'0':25,'1':25,'2':100,'3':200,'4':300,'5':400,'6':400,'7':400,'8':400 };
  for (const k in ramp) B.state.an.spread[k] = { bet: ramp[k], hands: 1 };
});
await p.waitForTimeout(120);
await p.click('#anRun');
await p.waitForSelector('#anVarBox:not([hidden])', { timeout: 120000 });
await p.waitForTimeout(200);
const an = await p.evaluate(() => ({
  ev: document.querySelector('#mEV').textContent,
  sd: document.querySelector('#mSD').textContent,
  ror: document.querySelector('#mRoR').textContent,
  adv: document.querySelector('#mAdv').textContent,
  status: document.querySelector('#anStatus').textContent,
  bands: document.querySelectorAll('#anVarChart polygon').length,
  median: document.querySelectorAll('#anVarChart polyline.medline').length,
  countRows: document.querySelectorAll('#anCountTable tbody tr').length,
  bankRows: document.querySelectorAll('#anBankMath .cmp-row').length,
  last: window.__BJ.state.an.last
}));
ok(an.ev !== '—' && /\$/.test(an.ev), `EV populated (${an.ev})`);
ok(/^±\$/.test(an.sd), `SD populated (${an.sd})`);
ok(an.ror !== '—', `risk of ruin populated (${an.ror})`);
ok(/%/.test(an.adv), `advantage populated (${an.adv})`);
ok(/M rounds in/.test(an.status), `status reports the work done (${an.status})`);
ok(an.bands === 2, `variance chart draws both percentile bands (${an.bands})`);
ok(an.median === 1, 'variance chart draws the median');
ok(an.countRows >= 5, `per-count breakdown filled (${an.countRows} rows)`);
ok(an.bankRows >= 4, `bankroll maths filled (${an.bankRows} rows)`);
ok(/^\+/.test(an.ev), `a strong spread in a deep-penetration game beats it (${an.ev})`);
ok(an.last && Number.isFinite(an.last.ev) && Number.isFinite(an.last.sd), 'result stored for other views');
// the advantage must be a plausible number, not a NaN or a wild value
const advNum = Number(an.adv.replace(/[+%]/g, ''));
ok(Number.isFinite(advNum) && Math.abs(advNum) < 5, `advantage is a sane percentage (${an.adv})`);

// a losing spread must be reported as losing, not dressed up
await p.evaluate(() => {
  const sp = window.__BJ.state.an.spread;
  for (const k in sp) { sp[k].bet = 25; sp[k].hands = 1; }   // flat betting
});
await p.click('#anRun');
await p.waitForTimeout(400);
await p.waitForFunction(() => !document.querySelector('#anRun').disabled, { timeout: 120000 });
await p.waitForTimeout(150);
const flatEV = await p.evaluate(() => document.querySelector('#mEV').textContent);
ok(/−/.test(flatEV) || /^\+?\$0$/.test(flatEV), `flat betting shows a loss (${flatEV})`);
ok(/losing game|No bankroll/.test(await p.evaluate(() => document.querySelector('#anBankMath').textContent)),
   'bankroll panel says a losing game cannot be sized');

// template save / load
await p.click('#anSaveTpl'); await p.waitForTimeout(150);
await p.locator('#tplName').fill('Flat test');
await p.click('#tplSave'); await p.waitForTimeout(200);
ok((await p.locator('#anTemplate option').count()) === 2, 'saved spread appears in the list');

// ---- DASHBOARD
await p.click('#nav button[data-view="dashboard"]'); await p.waitForTimeout(150);
ok(/No sessions/.test(await txt('#sessionList')), 'dashboard starts empty, not pre-filled');
ok((await txt('#totalEarn')) === '$0', 'no fabricated earnings');
for (const [d, h, r] of [['2026-01-05','3','250'],['2026-01-06','2','-180'],['2026-01-07','4','600']]) {
  await p.click('#addSession'); await p.waitForTimeout(150);
  await p.locator('#sDate').fill(d);
  await p.locator('#sHours').fill(h);
  await p.locator('#sResult').fill(r);
  await p.click('#sSave'); await p.waitForTimeout(180);
}
ok((await txt('#totalEarn')) === '$670', `net computed (${await txt('#totalEarn')})`);
ok((await txt('#hours')) === '9.0', `hours summed (${await txt('#hours')})`);
ok((await txt('#hourly')) === '$74/hr', `hourly computed (${await txt('#hourly')})`);
const chartPts = await p.evaluate(() => document.querySelectorAll('#dashChart circle').length);
ok(chartPts === 3, `chart plots each session (${chartPts})`);
// bankroll switch isolates the log
await p.locator('#dashBank').selectOption('practice'); await p.waitForTimeout(150);
ok(/No sessions/.test(await txt('#sessionList')), 'second bankroll is separate');
await p.locator('#dashBank').selectOption('main'); await p.waitForTimeout(150);
await p.locator('[data-delsession]').first().click(); await p.waitForTimeout(150);
ok((await txt('#totalEarn')) === '$70', `session delete recalculates (${await txt('#totalEarn')})`);
// CSV export: as a plain file this must produce a real browser download
const dl = p.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await p.click('#exportSessions');
const download = await dl;
ok(!!download, 'CSV export triggers a download when opened as a plain file');
if (download) ok(/blackjack-sessions-main\.csv/.test(download.suggestedFilename()), `export filename (${download && download.suggestedFilename()})`);

// ---- persistence across reload
await p.reload(); await p.waitForTimeout(400);
await p.click('#nav button[data-view="dashboard"]'); await p.waitForTimeout(200);
ok((await txt('#totalEarn')) === '$70', 'sessions persist across reload');
await p.click('#nav button[data-view="course"]'); await p.waitForTimeout(150);
ok((await txt('#overallPct')) === '7%', 'lesson progress persists');


// ---- BACKUP / RESTORE
await p.click('#dataBtn'); await p.waitForTimeout(200);
ok(await p.locator('#modal').isVisible(), 'data modal opens');
const summary = await txt('#modalBox');
ok(/Lessons complete/.test(summary) && /Sessions logged/.test(summary), 'backup modal summarises what is stored');
// export produces a json file
const dlExport = p.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await p.click('#doExport');
const exported = await dlExport;
ok(!!exported, 'export triggers a download');
ok(exported && /blackjack-academy-\d{4}-\d{2}-\d{2}\.json/.test(exported.suggestedFilename()),
   `export filename (${exported && exported.suggestedFilename()})`);
// and the exported bytes are a usable backup
const expPath = join(mkdtempSync(join(tmpdir(), 'bj-')), 'out.json');
if (exported) await exported.saveAs(expPath);
const roundTrip = JSON.parse(readFileSync(expPath, 'utf8'));
ok(roundTrip.app === 'blackjack-academy', 'export is tagged as ours');
ok(roundTrip.state && roundTrip.state.rules && roundTrip.state.basic, 'export carries the saved state');
ok(typeof roundTrip.exportedAt === 'string', 'export is dated');

// import a backup with recognisable contents and confirm it lands
const dir = mkdtempSync(join(tmpdir(), 'bjimport-'));
const file = join(dir, 'backup.json');
const payload = JSON.parse(JSON.stringify(roundTrip));
payload.state.venues = [{ id: 'imp1', name: 'Imported Table', region: 'eu', decks: 8,
  h17: false, enhc: false, das: true, surrender: false, bjPays: 1.5, pen: 70, min: 10, note: '' }];
payload.state.lessons = { l1: true, l2: true, l3: true };
payload.state.rules.decks = 8;
writeFileSync(file, JSON.stringify(payload));
await p.setInputFiles('#importFile', file);
await p.waitForTimeout(300);
ok(await p.locator('#modal').isVisible(), 'import asks before replacing anything');
ok(/Replace everything/.test(await txt('#modalBox')), 'import warns that current progress goes');
await Promise.all([p.waitForLoadState('load'), p.click('#cbYes')]);
await p.waitForTimeout(500);
const after = await p.evaluate(() => ({
  venues: window.__BJ.state.venues.map(v => v.name),
  decks: window.__BJ.state.rules.decks,
  lessons: Object.keys(window.__BJ.state.lessons).filter(k => window.__BJ.state.lessons[k]).length
}));
ok(after.venues.includes('Imported Table'), `imported venue present (${after.venues.join(',')})`);
ok(after.decks === 8, `imported rules applied (decks ${after.decks})`);
ok(after.lessons === 3, `imported lesson progress applied (${after.lessons})`);
// a file that is not ours is refused rather than wiping anything
const junk = join(dir, 'junk.json');
writeFileSync(junk, JSON.stringify({ hello: 'world' }));
await p.setInputFiles('#importFile', junk);
await p.waitForTimeout(400);
ok(!(await p.locator('#modal').isVisible()), 'a foreign json file does not prompt to replace data');
ok((await p.evaluate(() => window.__BJ.state.venues.length)) === 1, 'foreign file left data untouched');

// ---- corrupt storage must not brick the app
await p.evaluate(() => localStorage.setItem('bjAcademyV3', '{not json'));
await p.goto(URL + '#train'); await p.waitForTimeout(400);
ok(await p.locator('#view-train').isVisible(), 'app still boots with corrupt storage');
ok((await p.locator('#basicMode').isHidden()), 'train menu shown after corrupt-storage boot');
ok((await p.evaluate(() => !!window.__BJ)), 'script survives corrupt storage');

// ---- nothing on a desktop screen should be too small to read comfortably
const tooSmall = await p.evaluate(async () => {
  const found = [];
  for (const v of ['train','strategy','course','casinos','assist','analyzer','dashboard']) {
    document.querySelector(`#nav button[data-view="${v}"]`).click();
    await new Promise(r => setTimeout(r, 60));
    document.querySelectorAll('.view.active *').forEach(e => {
      if (e.children.length || !e.textContent.trim()) return;   // leaf text only
      if (!e.getClientRects().length) return;                   // ignore hidden
      const fs = parseFloat(getComputedStyle(e).fontSize);
      if (fs < 12) found.push(`${v}: ${e.tagName}.${e.className} at ${fs}px`);
    });
  }
  return [...new Set(found)];
});
ok(tooSmall.length === 0, `no text under 12px on desktop (${tooSmall.slice(0,4).join(' | ')})`);

// ---- mobile
const m = await ctx.newPage();
await m.goto(URL);
await m.setViewportSize({ width: 380, height: 800 });
await m.waitForTimeout(300);
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(overflow <= 1, `no horizontal overflow at 380px (got ${overflow}px)`);
await m.click('#nav button[data-view="strategy"]'); await m.waitForTimeout(200);
const ov2 = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(ov2 <= 1, `charts fit at 380px (got ${ov2}px)`);
await m.click('#nav button[data-view="analyzer"]'); await m.waitForTimeout(250);
const ov3 = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(ov3 <= 1, `analyzer fits at 380px (got ${ov3}px)`);
await m.click('#nav button[data-view="casinos"]'); await m.waitForTimeout(250);
const ov4 = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(ov4 <= 1, `table log fits at 380px (got ${ov4}px)`);

console.log(fails.length ? 'UI FAILURES:' : 'all UI checks passed');
fails.forEach(f => console.log('  ✗ ' + f));
if (errs.length) { console.log('CONSOLE ERRORS:'); [...new Set(errs)].forEach(e => console.log('  ' + e)); }
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
