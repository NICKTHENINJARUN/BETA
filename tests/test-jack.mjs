// Jack is the coach built into the page. He is not a language model, so his
// answers are deterministic and can be asserted exactly — which is the point:
// every play he quotes has to match the engine.
import { chromium, APP_URL } from './harness.mjs';

const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await p.goto(APP_URL);
await p.waitForTimeout(400);

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const ask = q => p.evaluate(x => window.__BJ.jackAnswer(x), q);

// ---- nothing reaches the network, and no model is involved
const netHits = [];
p.on('request', r => { if (!r.url().startsWith('file://')) netHits.push(r.url()); });

// ---- hand questions, in the shapes people actually type
const handCases = [
  ['16 v 10', /hard 16.*dealer 10/i, null],
  ['what do I do with 16 vs 10 at +2', /STAND/, 'index applies at +2'],
  ['16 v 10 at -3', /SURRENDER|HIT/, 'below the index'],
  ['should I split 8s against an ace', /pair of 8s.*dealer A/i, 'split Xs phrasing'],
  ['aces against 6', /pair of As/i, 'bare plural means a pair'],
  ['should I be splitting 9s vs 7', /pair of 9s.*dealer 7/i, 'splitting Xs phrasing'],
  ['10s v 5 at +5', /SPLIT/, 'tens split at a high count'],
  ['pair of 8s vs 10', /SPLIT/, '8,8 always splits'],
  ['8,8 v 10', /SPLIT/, 'comma form parses'],
  ['a,7 vs 3', /soft 18/i, 'soft hand parses'],
  ['soft 18 against 9', /HIT/, 'A,7 v 9 hits'],
  ['10,10 vs 6', /STAND/, 'never split tens at neutral'],
  ['11 versus ace', /hard 11.*dealer A/i, 'versus + word ace'],
  ['hard 12 v 4', /STAND/, '12 v 4 stands'],
  ['12 vs 3', /HIT/, '12 v 3 hits'],
  ['two aces against 6', /SPLIT/, 'pair of aces splits'],
  ['what about 15 vs king', /hard 15.*dealer 10/i, 'face card maps to ten']
];
for (const [q, re, label] of handCases) {
  const a = await ask(q);
  ok(re.test(a), `"${q}" → ${label || 'parsed'} (got: ${a.split('\n')[0]})`);
  ok(!/undefined|NaN|\[object/.test(a), `"${q}" produces clean prose`);
}

// ---- Jack's play must equal the engine's play, never drift from it
const agreement = await p.evaluate(() => {
  const B = window.__BJ, out = [];
  const ranks = ['A','2','3','4','5','6','7','8','9','10'];
  for (const a of ranks) for (const c of ranks) for (const up of ranks) {
    const cards = [a, c].map(r => B.card(r, '♠'));
    const h = B.handInfo(cards), r = B.state.rules;
    const ctx = { canDouble: true, canSplit: h.pair, canSurrender: r.surrender && !r.enhc, das: r.das };
    const want = B.basicPlay(cards, B.card(up, '♣'), r, ctx);
    const said = B.jackAnswer(`${a},${c} vs ${up}`);
    const m = said.match(/\*\*([A-Z]+)\*\*/);
    if (!m) { out.push(`${a},${c} v ${up}: no verdict`); continue; }
    if (m[1] !== want) out.push(`${a},${c} v ${up}: Jack said ${m[1]}, engine says ${want}`);
  }
  return out;
});
ok(agreement.length === 0, `Jack matches the engine on every two-card hand (${agreement.length} mismatches: ${agreement.slice(0,3).join('; ')})`);

// ---- a deviation must be explained as a deviation, not with the chart's reasoning
const dev = await ask('16 v 10 at +2');
ok(/STAND/.test(dev), 'the index applies');
ok(!/stand against 2 through 6/i.test(dev),
   'the count-driven stand is not explained with the weak-dealer rule');
ok(/rich shoe|breaks more often/i.test(dev), 'the deviation gets its own reasoning');
ok(!/\+0\b/.test(dev), 'a zero index prints as 0, not +0');
const devHit = await ask('13 v 2 at -3');
ok(/HIT/.test(devHit) && /small cards are still/i.test(devHit), 'a negative-count deviation reads correctly');
const noDev = await ask('16 v 5');
ok(/stand against 2 through 6/i.test(noDev), 'a plain basic-strategy stand keeps the chart reasoning');

// ---- true count arithmetic
const tc = await ask('what is the true count if running count is 9 with 3 decks left');
ok(/\+3/.test(tc) && /÷ 3/.test(tc), `true count computed and shown (${tc.split('\n')[0]})`);
const tcNeg = await ask('running count -7 with 2 decks remaining');
ok(/−3/.test(tcNeg), `negative counts round toward zero (${tcNeg.split('\n')[0]})`);

// ---- knowledge topics all answer, and none throw
const topics = await p.evaluate(() => window.__BJ.JACK_TOPICS.filter(t => !t.needsHand).map(t => t.k[0]));
for (const t of topics) {
  const a = await ask(t);
  ok(typeof a === 'string' && a.length > 80, `topic "${t}" gives a real answer (${(a||'').length} chars)`);
  ok(!/undefined|NaN|\[object/.test(a), `topic "${t}" is clean`);
}

// ---- identity: Jack must be honest about what he is
const who = await ask('what are you');
ok(/Jack/.test(who), 'Jack gives his name');
ok(/blackjack/i.test(who), 'Jack says what he is for');
ok(who.length < 340, `the introduction is short, not a manifesto (${who.length} chars)`);
ok(!/language model|nothing leaves|offline|no cost|engine/i.test(who),
   'the introduction does not narrate the implementation');
// asked directly he is still straight about it, in one line rather than an essay
const model = await ask('are you chatgpt?');
ok(/not one of the general chatbots/i.test(model), 'asked directly, Jack answers honestly');
ok(!/I am (ChatGPT|Claude|GPT)\b/i.test(model), 'Jack does not claim to be another assistant');
ok(model.length < 380, `and keeps it brief (${model.length} chars)`);

// ---- coaching reads the real record
const coachEmpty = await ask('what should I practise');
ok(/haven't played a drill yet/i.test(coachEmpty), 'with no record Jack says so rather than inventing one');
await p.evaluate(() => {
  const B = window.__BJ;
  B.state.basic.n = 200; B.state.basic.c = 150; B.state.basic.best = 9;
  B.state.basic.misses = { 'pair 8 v 10': 6, 'pair 9 v 7': 4, 'pair 2 v 3': 3, 'hard 16 v 10': 2 };
});
const coach = await ask('what am I bad at');
ok(/75%/.test(coach), `coaching quotes the real accuracy (${coach.split('\n')[0]})`);
ok(/pair 8 v 10/.test(coach), 'coaching names the actual missed hands');
ok(/Most of those are pairs/.test(coach), 'coaching spots the pattern across misses');
ok(/before touching deviations/.test(coach), 'coaching gives the right priority at 75%');

// ---- fallback is honest rather than bluffing
const junk = await ask('what is the capital of France');
ok(/didn't land/i.test(junk), 'off-topic questions get a straight answer, not a bluff');
ok(/16 v 10/.test(junk), 'the refusal shows what does work');
ok(junk.length < 320, `the refusal is brief (${junk.length} chars)`);

// ---- the chat UI end to end
await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
ok(await p.locator('#asAIBody').isVisible(), 'Jack is available with no runtime check');
const greeting = await p.evaluate(() => document.querySelector('#asChat').textContent);
ok(/16 v 10/.test(greeting), 'the opening line shows how to ask');
ok(greeting.length < 220, `the opening line is short (${greeting.length} chars)`);
await p.locator('#asInput').fill('16 v 10 at +2');
await p.click('#asSend');
await p.waitForFunction(() => !document.querySelector('#asSend').disabled, { timeout: 15000 });
const bubbles = await p.evaluate(() => [...document.querySelectorAll('#asChat .bubble')].map(x => x.className + '|' + x.textContent));
ok(bubbles.length >= 3, `question and answer rendered (${bubbles.length} bubbles)`);
ok(/STAND/.test(bubbles[bubbles.length - 1]), 'the answer reaches the bubble in full');
ok(!/working it out/.test(bubbles[bubbles.length - 1]), 'the thinking placeholder is replaced');
// quick chips
await p.click('#asQuick [data-ask="What can you do?"]');
await p.waitForFunction(() => !document.querySelector('#asSend').disabled, { timeout: 15000 });
ok(/what should I practise/i.test(await p.evaluate(() => document.querySelector('#asChat').textContent)), 'quick chips work');
// Enter sends
await p.locator('#asInput').fill('what is hi-lo');
await p.locator('#asInput').press('Enter');
await p.waitForFunction(() => !document.querySelector('#asSend').disabled, { timeout: 15000 });
ok(/\+1/.test(await p.evaluate(() => document.querySelector('#asChat').textContent)), 'Enter sends the question');

// ---- Jack follows the app's rules rather than assuming one game
await p.evaluate(() => { window.__BJ.state.rules.surrender = false; });
const noSurr = await ask('16 v 10');
ok(/HIT/.test(noSurr) && !/\*\*SURRENDER\*\*/.test(noSurr), `Jack follows the current rule set (${noSurr.split('\n')[0]})`);
await p.evaluate(() => { window.__BJ.state.rules.surrender = true; });

ok(netHits.length === 0, `nothing left the page (${netHits.slice(0,3).join(', ')})`);
ok(errs.length === 0, `no page errors (${errs.join('; ')})`);

console.log(fails.length ? 'JACK FAILURES:' : `Jack behaves — ${handCases.length} hand forms, ${topics.length} topics, every two-card hand agrees with the engine`);
fails.forEach(f => console.log('  x ' + f));
await b.close();
process.exit(fails.length ? 1 : 0);
