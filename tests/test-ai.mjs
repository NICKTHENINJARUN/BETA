// Exercises the Assist tab's Claude paths against a stand-in for the artifact
// runtime. The live call itself needs a signed-in viewer and spends their
// account, so it cannot run here — but everything the page controls can:
// availability, the grounding prompt, streaming, cancel, every error code,
// and the photo-to-rules flow.
import { chromium, APP_URL } from './harness.mjs';

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

/** Install a fake window.claude before any page script runs. */
async function withRuntime(page, opts = {}) {
  await page.addInitScript((o) => {
    window.__aiCalls = [];
    const mkSample = () => {
      const fn = async (input, options = {}) => {
        window.__aiCalls.push({ input, options: { modelTier: options.modelTier, cache: options.cache, hasSignal: !!options.signal, images: !!options.images } });
        if (o.failCode) { const e = { code: o.failCode, message: 'mock failure' }; if (o.failText) e.text = o.failText; throw e; }
        const reply = o.reply || 'Because the dealer breaks often enough here.';
        if (o.hang) {
          // stream one chunk then wait to be aborted
          options.onText && options.onText({ text: 'Thinking it over', delta: 'Thinking it over' });
          await new Promise((res, rej) => {
            options.signal && options.signal.addEventListener('abort', () => rej({ code: 'cancelled', text: 'Thinking it over' }));
          });
        }
        const parts = reply.split(' ');
        let acc = '';
        for (const w of parts) {
          acc += (acc ? ' ' : '') + w;
          options.onText && options.onText({ text: acc, delta: (acc === w ? w : ' ' + w) });
          await new Promise(r => setTimeout(r, 2));
        }
        return { text: reply, truncated: !!o.truncated, modelTierApplied: options.modelTier || 'default' };
      };
      fn.limits = async () => {
        if (o.limitsThrow) throw { code: 'capability_removed', message: 'no limits' };
        return { maxPromptBytes: 65536, ...(o.images === false ? {} : { images: { maxCount: 1, maxInputBytes: 2e7, mediaTypes: ['image/jpeg', 'image/png'] } }) };
      };
      fn.json = async (input, options = {}) => {
        window.__aiCalls.push({ input, json: true, options: { images: !!options.images } });
        if (o.jsonFail) throw { code: 'invalid_json', message: 'bad', text: 'not json' };
        return o.jsonReply || { decks: 8, h17: false, das: true, surrender: false, bjPays: 1.2, min: 10, notes: 'Read from the sign.' };
      };
      return fn;
    };
    window.claude = { use: async (name) => (name === 'sample' && !o.absent) ? mkSample() : null };
  }, opts);
}

const browser = await chromium.launch();

// ---------- 1. the panel opens when the runtime is present
{
  const p = await browser.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await withRuntime(p);
  await p.goto(APP_URL); await p.waitForTimeout(500);
  await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
  ok(await p.locator('#asAIBody').isVisible(), 'AI panel opens when the runtime offers sampling');
  ok(!(await p.locator('#asAIState').isVisible()), 'the "checking" message goes away');
  ok(await p.locator('#asPhoto').isVisible(), 'photo button shown when the view can send images');

  // ask a question and check what actually got sent
  await p.click('#asUp [data-up="10"]');
  await p.click('#asCards [data-card="10"]');
  await p.click('#asCards [data-card="6"]');
  await p.locator('#asRC').fill('4'); await p.locator('#asDecks').fill('2');
  await p.waitForTimeout(150);
  await p.locator('#asTier').selectOption('quick');
  await p.locator('#asInput').fill('Why do I stand here?');
  await p.click('#asSend');
  await p.waitForTimeout(600);
  const call = await p.evaluate(() => window.__aiCalls[0]);
  ok(Array.isArray(call.input), 'sent as a turn list');
  ok(call.input[0].role === 'user', 'first turn is a user turn (standing instructions)');
  ok(call.input[call.input.length - 1].role === 'user', 'last turn is a user turn');
  ok(/ENGINE'S CORRECT PLAY: STAND/.test(call.input[0].content), 'the engine verdict is in the prompt');
  ok(/16 vs 10/.test(call.input[0].content), 'the governing index is in the prompt');
  ok(/never contradict/i.test(call.input[0].content), 'Claude is told not to contradict the engine');
  ok(call.input[call.input.length - 1].content === 'Why do I stand here?', 'the question is the final turn');
  ok(call.options.modelTier === 'quick', `chosen tier is passed (${call.options.modelTier})`);
  ok(call.options.cache === false, 'caching off so every ask is fresh');
  ok(call.options.hasSignal, 'a cancel signal is attached');
  const bubbles = await p.evaluate(() => [...document.querySelectorAll('#asChat .bubble')].map(b => b.className + '|' + b.textContent));
  ok(bubbles.length === 2, `question and answer both rendered (${bubbles.length})`);
  ok(/dealer breaks/.test(bubbles[1]), 'the streamed answer is shown');
  ok(!/Thinking/.test(bubbles[1]), 'the thinking placeholder is replaced');

  // a follow-up carries the prior turns
  await p.locator('#asInput').fill('And if the count drops?');
  await p.click('#asSend'); await p.waitForTimeout(600);
  const second = await p.evaluate(() => window.__aiCalls[1]);
  ok(second.input.length >= 4, `follow-up carries history (${second.input.length} turns)`);
  ok(second.input.some(t => t.role === 'assistant'), 'the earlier reply is included as context');
  ok(errs.length === 0, `no page errors (${errs.join('; ')})`);
  await p.close();
}

// ---------- 2. quick actions
{
  const p = await browser.newPage();
  await withRuntime(p);
  await p.goto(APP_URL); await p.waitForTimeout(500);
  await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
  await p.click('#asQuick [data-ask="why"]'); await p.waitForTimeout(300);
  ok((await p.evaluate(() => window.__aiCalls.length)) === 0, '"Why this play" refuses without a hand on screen');
  await p.click('#asQuick [data-ask="spread"]'); await p.waitForTimeout(500);
  const spreadCall = await p.evaluate(() => window.__aiCalls[0]);
  ok(!!spreadCall, 'spread review fires without needing a hand');
  ok(/Bet spread/.test(spreadCall.input[0].content), 'the spread is in the prompt');
  await p.close();
}

// ---------- 3. every failure mode the contract defines
const cases = [
  ['not_granted', /declined Claude/i, true],
  ['rate_limited', /Too many questions/i, false],
  ['sampling_disabled', /not available on this account/i, true],
  ['session_expired', /sign in again/i, false],
  ['refused', /declined to answer/i, false],
  ['upstream_error', /went wrong/i, false],
  ['some_unknown_code', /went wrong/i, false]
];
for (const [code, pattern, hidesPanel] of cases) {
  const p = await browser.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await withRuntime(p, { failCode: code });
  await p.goto(APP_URL); await p.waitForTimeout(500);
  await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
  await p.locator('#asInput').fill('test');
  await p.click('#asSend'); await p.waitForTimeout(500);
  const txt = await p.evaluate(() => document.querySelector('#asChat').textContent);
  ok(pattern.test(txt), `${code}: viewer sees a useful message (got "${txt.slice(-70)}")`);
  ok(!/undefined|\[object/.test(txt), `${code}: no raw error leaks into the UI`);
  const panelHidden = !(await p.locator('#asAIBody').isVisible());
  ok(panelHidden === hidesPanel, `${code}: panel ${hidesPanel ? 'hides' : 'stays usable'}`);
  const sendOk = await p.evaluate(() => !document.querySelector('#asSend').disabled);
  ok(sendOk, `${code}: the Ask button is re-enabled afterwards`);
  ok(errs.length === 0, `${code}: no unhandled page error`);
  await p.close();
}

// ---------- 4. Stop cancels a running answer
{
  const p = await browser.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await withRuntime(p, { hang: true });
  await p.goto(APP_URL); await p.waitForTimeout(500);
  await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
  await p.locator('#asInput').fill('long one');
  await p.click('#asSend'); await p.waitForTimeout(300);
  ok(await p.locator('#asStop').isVisible(), 'Stop appears while an answer is running');
  await p.click('#asStop'); await p.waitForTimeout(400);
  const txt = await p.evaluate(() => document.querySelector('#asChat').textContent);
  ok(/\[stopped\]/.test(txt), 'stopping marks the answer as stopped');
  ok(/Thinking it over/.test(txt), 'the partial answer is kept');
  ok(!(await p.locator('#asStop').isVisible()), 'Stop hides again');
  ok(await p.evaluate(() => !document.querySelector('#asSend').disabled), 'Ask is usable again after a stop');
  ok(errs.length === 0, `stop: no unhandled error (${errs.join('; ')})`);
  await p.close();
}

// ---------- 5. photo of a rules sign -> parsed -> applied
{
  const p = await browser.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await withRuntime(p);
  await p.goto(APP_URL); await p.waitForTimeout(500);
  await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await p.setInputFiles('#asPhotoFile', { name: 'sign.png', mimeType: 'image/png', buffer: png });
  await p.waitForTimeout(600);
  const jsonCall = await p.evaluate(() => window.__aiCalls.find(c => c.json));
  ok(!!jsonCall, 'photo goes through the JSON path');
  ok(jsonCall.options.images, 'the image is attached to the call');
  ok(/only a JSON object/.test(jsonCall.input), 'the prompt pins the output shape');
  const shown = await p.evaluate(() => document.querySelector('#asChat').textContent);
  ok(/8 decks/.test(shown) && /S17/.test(shown) && /6:5/.test(shown), `parsed rules are shown (${shown.slice(-80)})`);
  await p.click('#asChat button'); await p.waitForTimeout(300);
  const applied = await p.evaluate(() => ({ decks: window.__BJ.state.rules.decks, h17: window.__BJ.state.rules.h17, bj: window.__BJ.state.rules.bjPays }));
  ok(applied.decks === 8 && applied.h17 === false && applied.bj === 1.2, `rules applied to the app (${JSON.stringify(applied)})`);
  ok(errs.length === 0, `photo: no unhandled error (${errs.join('; ')})`);
  await p.close();
}

// ---------- 6. degraded runtimes must not strand the panel
{
  // limits() rejecting used to throw past the reveal and leave "Checking..." forever
  const p = await browser.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await withRuntime(p, { limitsThrow: true });
  await p.goto(APP_URL); await p.waitForTimeout(600);
  await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
  ok(await p.locator('#asAIBody').isVisible(), 'panel still opens when limits() fails');
  ok(!(await p.locator('#asPhoto').isVisible()), 'photo button hidden when limits are unknown');
  ok(errs.length === 0, `limits failure: no unhandled error (${errs.join('; ')})`);
  await p.close();
}
{
  // use() resolving null (framed by something that is not a Claude viewer)
  const p = await browser.newPage();
  await withRuntime(p, { absent: true });
  await p.goto(APP_URL); await p.waitForTimeout(600);
  await p.click('#nav button[data-view="assist"]'); await p.waitForTimeout(200);
  ok(await p.locator('#asAIState').isVisible(), 'absence is explained');
  ok(/not available in this view/.test(await p.evaluate(() => document.querySelector('#asAIState').textContent)), 'the message says why');
  ok(!(await p.locator('#asAIBody').isVisible()), 'chat stays hidden');
  // and the deterministic half still works
  await p.click('#asUp [data-up="10"]');
  await p.click('#asCards [data-card="10"]');
  await p.click('#asCards [data-card="6"]');
  await p.locator('#asRC').fill('4'); await p.locator('#asDecks').fill('2');
  await p.waitForTimeout(200);
  ok((await p.evaluate(() => document.querySelector('#asAct').textContent)) === 'STAND',
     'the engine verdict still works with no Claude at all');
  await p.close();
}

console.log(fails.length ? 'AI FAILURES:' : 'all AI paths behave');
fails.forEach(f => console.log('  x ' + f));
await browser.close();
process.exit(fails.length ? 1 : 0);
