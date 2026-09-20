/* Accessibility checks, run against the real page in a real browser.
   Everything here is a thing that was actually broken at some point: controls
   that announced as "button" with no name, fields whose visible label was never
   tied to them, drill feedback that a screen reader never heard, chart cells
   that only a mouse could open, a dialog you could tab straight out of, and a
   grey ramp you had to already know the words to read. */
import { chromium, APP_URL } from './harness.mjs';

const VIEWS = ['train', 'strategy', 'course', 'casinos', 'assist', 'analyzer', 'dashboard'];
const fails = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(APP_URL);
await p.waitForTimeout(400);

/* ---------------------------------------------------------- page basics */
ok(await p.getAttribute('html', 'lang') === 'en', 'html carries a lang');
ok(await p.locator('a.skip').count() === 1, 'there is a skip link');
ok(await p.locator('main#main').count() === 1, 'there is a main landmark');

// The skip link is the first thing Tab reaches, or it is useless.
await p.keyboard.press('Tab');
ok(await p.evaluate(() => document.activeElement.classList.contains('skip')),
   'the skip link is the first tab stop');

/* --------------------------------------------- names, labels, live regions */
/* Walked per view: a control only joins the accessibility tree when its screen
   is on, so checking the initial view alone would miss most of them. */
for (const v of VIEWS) {
  await p.click(`#nav button[data-view="${v}"]`);
  await p.waitForTimeout(220);

  const r = await p.evaluate(() => {
    const named = el => !!(
      el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') ||
      el.textContent.trim() ||
      el.title
    );
    const shown = el => !!el.offsetParent;

    const unnamed = [...document.querySelectorAll('button, a[href], [role=button], [role=switch], [role=tab]')]
      .filter(el => shown(el) && !named(el))
      .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));

    const unlabelled = [...document.querySelectorAll('input, select, textarea')]
      .filter(el => {
        if (el.type === 'hidden') return false;
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
        if (el.closest('label')) return false;
        return true;
      })
      .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));

    return { unnamed, unlabelled };
  });

  ok(r.unnamed.length === 0, `${v}: every control has a name (missing: ${r.unnamed.join(', ')})`);
  ok(r.unlabelled.length === 0, `${v}: every field has a label (missing: ${r.unlabelled.join(', ')})`);
}

// Feedback that only appears visually is feedback a screen reader user never gets.
const live = await p.evaluate(() =>
  ['basicFeedback', 'devFeedback', 'runFeedback', 'tcFeedback', 'simFeedback', 'asChat']
    .filter(id => {
      const el = document.getElementById(id);
      return el && (el.getAttribute('aria-live') || ['status', 'alert', 'log'].includes(el.getAttribute('role')));
    }).length);
ok(live === 6, `all six output areas announce themselves (got ${live})`);

/* ------------------------------------------------------------- tab set */
await p.click('#nav button[data-view="train"]');
await p.waitForTimeout(150);
ok(await p.locator('#nav[role=tablist]').count() === 1, 'the nav is a tablist');

const selected = await p.evaluate(() =>
  [...document.querySelectorAll('#nav button')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.view));
ok(selected.length === 1 && selected[0] === 'train', `exactly one tab is selected (${selected})`);

// Arrow keys drive a tab set; Tab alone would trap you in it.
await p.focus('#nav button[data-view="train"]');
await p.keyboard.press('ArrowRight');
await p.waitForTimeout(200);
ok(await p.evaluate(() => document.activeElement.dataset.view) === 'strategy',
   'ArrowRight moves to the next tab');
ok(await p.locator('#view-strategy.active').count() === 1, 'and selects it');

await p.keyboard.press('End');
await p.waitForTimeout(200);
ok(await p.evaluate(() => document.activeElement.dataset.view) === 'dashboard',
   'End jumps to the last tab');

/* ------------------------------------------------- charts: tables and cells */
await p.click('#nav button[data-view="strategy"]');
await p.waitForTimeout(250);

const tbl = await p.evaluate(() => [...document.querySelectorAll('#chartArea table.strategy-table')].map(t => ({
  caption: !!t.querySelector('caption'),
  heads: t.querySelectorAll('th').length,
  scoped: t.querySelectorAll('th[scope]').length,
})));
ok(tbl.length > 0, 'the charts render tables');
ok(tbl.every(t => t.caption), 'every chart table has a caption');
ok(tbl.every(t => t.heads > 0 && t.heads === t.scoped),
   'every header cell says what it heads');

// A cell reads as one letter. The label has to carry the whole meaning.
const cell = await p.evaluate(() => {
  const td = document.querySelector('#chartArea td[data-cards]');
  return { label: td.getAttribute('aria-label') || '', tabindex: td.getAttribute('tabindex'), role: td.getAttribute('role') };
});
ok(cell.tabindex === '0' && cell.role === 'button', 'chart cells are reachable and announced as controls');
ok(/against dealer/i.test(cell.label) && cell.label.length > 25,
   `chart cell labels spell out the play (got "${cell.label}")`);

// Keyboard has to open the detail the same way a click does.
await p.evaluate(() => document.querySelector('#chartArea td[data-cards]').focus());
await p.keyboard.press('Enter');
await p.waitForTimeout(250);
ok(await p.locator('#modal.show').count() === 1, 'Enter opens a chart cell');

/* ------------------------------------------------------------- the dialog */
const dlg = await p.evaluate(() => {
  const box = document.getElementById('modalBox');
  return { role: box.getAttribute('role'), modal: box.getAttribute('aria-modal'), labelled: box.getAttribute('aria-labelledby') };
});
ok(dlg.role === 'dialog' && dlg.modal === 'true', 'the dialog says it is a dialog');
ok(!!dlg.labelled, 'and takes its name from its heading');

ok(await p.evaluate(() => document.getElementById('modalBox').contains(document.activeElement)),
   'focus moves into the dialog when it opens');

// Tab must not walk out of an open dialog and strand the keyboard behind it.
for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
ok(await p.evaluate(() => document.getElementById('modalBox').contains(document.activeElement)),
   'focus stays inside the dialog while it is open');

await p.keyboard.press('Escape');
await p.waitForTimeout(200);
ok(await p.locator('#modal.show').count() === 0, 'Escape closes the dialog');
ok(await p.evaluate(() => document.activeElement.hasAttribute('data-cards')),
   'and focus returns to the cell that opened it');

/* -------------------------------------------------------------- contrast */
/* WCAG AA: 4.5:1 for body text, 3:1 for large text. The whole muted ramp used
   to sit between 2.4 and 4.2, which is legible only if you already know what
   it says. */
const lowContrast = [];
for (const v of VIEWS) {
  await p.click(`#nav button[data-view="${v}"]`);
  await p.waitForTimeout(220);
  const bad = await p.evaluate((view) => {
    const lum = ([r, g, bl]) => {
      const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); };
      return .2126 * f(r) + .7152 * f(g) + .0722 * f(bl);
    };
    const parse = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const bgOf = el => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const a = (c.match(/[\d.]+/g) || [])[3];
        const m = parse(c);
        if (m.length === 3 && (a === undefined || +a > .85)) return m;
      }
      return [11, 11, 11];
    };
    const out = [];
    document.querySelectorAll('*').forEach(el => {
      if (!el.offsetParent) return;
      const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim())
        .map(n => n.textContent.trim()).join(' ');
      if (!txt) return;
      const st = getComputedStyle(el);
      const fg = parse(st.color);
      if (fg.length < 3) return;
      const L1 = lum(fg), L2 = lum(bgOf(el));
      const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
      const size = parseFloat(st.fontSize), weight = +st.fontWeight || 400;
      const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
      if (ratio < need) out.push(`${view}: ${ratio.toFixed(2)} < ${need} — ${st.color} ${size}px "${txt.slice(0, 32)}"`);
    });
    return out;
  }, v);
  lowContrast.push(...bad);
}
ok(lowContrast.length === 0,
   `all text meets WCAG AA contrast (${lowContrast.length} below: ${lowContrast.slice(0, 4).join(' | ')})`);

/* ------------------------------------------------- decorative noise is hidden */
const glyphs = await p.evaluate(() =>
  [...document.querySelectorAll('.trainicon, .jackmark')].filter(el => el.getAttribute('aria-hidden') !== 'true').length);
ok(glyphs === 0, `decorative glyphs are hidden from screen readers (${glyphs} exposed)`);

/* ==================================================== the multiplayer table */
/* The table is a second page on a real server, so it has to be held to the
   same bar rather than assumed to meet it. It was checked by hand when it was
   written, which is exactly the kind of check that quietly stops being true. */
{
  const { server, table } = await import('../server/index.mjs');
  const addr = await new Promise(res => server.listen(0, () => res(server.address())));
  const BASE = `http://127.0.0.1:${addr.port}`;
  const t = await b.newPage({ viewport: { width: 1100, height: 920 } });

  await t.goto(BASE + '/');
  await t.waitForTimeout(300);

  ok(await t.getAttribute('html', 'lang') === 'en', 'table: html carries a lang');
  ok(await t.locator('a.skip').count() === 1, 'table: there is a skip link');
  ok(await t.locator('main#main').count() === 1, 'table: there is a main landmark');

  await t.keyboard.press('Tab');
  ok(await t.evaluate(() => document.activeElement.classList.contains('skip')),
     'table: the skip link is the first tab stop');

  // Sign in and sit down, so the felt and its controls are on screen — the
  // signed-out form alone would miss most of the page.
  await t.click('#tabUp');
  await t.fill('#upName', 'A11y');
  await t.fill('#upEmail', `a11y-${Date.now()}@example.com`);
  await t.fill('#upPass', 'password123');
  await t.click('#formUp button[type=submit]');
  await t.waitForSelector('#tablePanel:not([hidden])', { timeout: 8000 });
  await t.click('#seats button');
  await t.waitForTimeout(400);
  await t.click('#chips button');
  await t.waitForTimeout(300);
  table.tick(Date.now() + 10 ** 7);          // close betting now, not in 15s
  await t.waitForSelector('#dealerHand .card', { timeout: 8000 });
  await t.waitForTimeout(400);

  const r = await t.evaluate(() => {
    const named = el => !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
      || el.textContent.trim() || el.title);
    const shown = el => !!el.offsetParent;
    const lum = ([r, g, bl]) => {
      const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); };
      return .2126 * f(r) + .7152 * f(g) + .0722 * f(bl);
    };
    const parse = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const bgOf = el => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const a = (c.match(/[\d.]+/g) || [])[3];
        const m = parse(c);
        if (m.length === 3 && (a === undefined || +a > .85)) return m;
      }
      return [11, 11, 11];
    };

    const unnamed = [...document.querySelectorAll('button,a[href],[role=button],[role=tab]')]
      .filter(el => shown(el) && !named(el)).map(el => el.tagName + (el.id ? '#' + el.id : ''));
    const unlabelled = [...document.querySelectorAll('input,select,textarea')].filter(el => {
      if (el.type === 'hidden' || !shown(el)) return false;
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
      return !el.closest('label');
    }).map(el => el.tagName + (el.id ? '#' + el.id : ''));

    const small = [], low = [];
    document.querySelectorAll('*').forEach(el => {
      if (!shown(el)) return;
      const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim())
        .map(n => n.textContent.trim()).join(' ');
      if (!txt) return;
      const st = getComputedStyle(el);
      const size = parseFloat(st.fontSize);
      if (size < 12) small.push(`${size}px "${txt.slice(0, 28)}"`);
      const fg = parse(st.color); if (fg.length < 3) return;
      const L1 = lum(fg), L2 = lum(bgOf(el));
      const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
      const need = (size >= 24 || (size >= 18.66 && +st.fontWeight >= 700)) ? 3 : 4.5;
      if (ratio < need) low.push(`${ratio.toFixed(2)}<${need} ${st.color} ${size}px "${txt.slice(0, 28)}"`);
    });

    // Cards carry a rank and a suit glyph; a screen reader needs the whole name.
    const cards = [...document.querySelectorAll('.card')];
    const unlabelledCards = cards.filter(c => !c.getAttribute('aria-label')).length;

    return {
      unnamed, unlabelled, small, low: [...new Set(low)],
      live: document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]').length,
      cards: cards.length, unlabelledCards,
    };
  });

  ok(r.unnamed.length === 0, `table: every control has a name (missing: ${r.unnamed.join(', ')})`);
  ok(r.unlabelled.length === 0, `table: every field has a label (missing: ${r.unlabelled.join(', ')})`);
  ok(r.small.length === 0, `table: no desktop text under 12px (${r.small.slice(0, 3).join(' | ')})`);
  ok(r.low.length === 0, `table: all text meets AA contrast (${r.low.slice(0, 3).join(' | ')})`);
  ok(r.live >= 4, `table: outputs announce themselves (${r.live} live regions)`);
  // Assert there is something to check before checking it, so this cannot
  // quietly pass on an empty felt.
  ok(r.cards > 0, `table: cards are on the felt when audited (${r.cards})`);
  ok(r.unlabelledCards === 0,
     `table: every card names its rank and suit (${r.unlabelledCards} of ${r.cards} unlabelled)`);

  await t.close();
  server.close();
}

await b.close();

console.log(`accessibility checks run: ${checks}`);
if (fails.length) {
  console.log('A11Y FAILURES:');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('all accessibility checks passed');
