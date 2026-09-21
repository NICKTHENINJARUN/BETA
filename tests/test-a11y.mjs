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

  // The table moved to /table when the server took over hosting the trainer
  // at the root, so this is the page under test rather than whatever / serves.
  await t.goto(BASE + '/table');
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

  /* Act, so the seat carries a badge. The size and contrast audits below only
     measure what is actually on screen, and a badge only exists once a seat
     has done something — so without this they covered it or not depending on
     whether the hand happened to be a natural. That is how an 11px badge got
     past them once and was then caught by luck.

     About one deal in fourteen resolves on the spot — a natural, or a dealer
     blackjack — and leaves no turn to take. Deal again until there is one
     rather than shrugging: a check that runs only most of the time fails
     only most of the time, which is worse than not having it. */
  for (let attempt = 0; attempt < 30 && !table.active; attempt++) {
    table.tick(Date.now() + 10 ** 7 * (attempt + 2));   // settle, re-bet, re-deal
    await t.waitForTimeout(120);
    if (!table.active && table.phase === 'betting') {
      await t.click('#chips button').catch(() => {});
      await t.waitForTimeout(150);
      table.tick(Date.now() + 10 ** 7 * (attempt + 2) + 1);
      await t.waitForTimeout(150);
    }
  }
  if (table.active) table.act(table.seats[table.active.seat].userId, 'stand');
  await t.waitForTimeout(400);
  ok(await t.locator('.seat .badge').count() > 0,
     'table: a seat shows what it did, so the audits below can measure it');
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

  /* The dealer: what she says has to reach a screen reader, what she looks like
     must not, and the sound has to be something you can find and turn off. */
  const dealer = await t.evaluate(() => {
    const say = document.getElementById('dealerSay');
    const fig = document.querySelector('.figure');
    const snd = document.getElementById('soundBtn');
    return {
      sayLive: say && say.getAttribute('aria-live') === 'polite' && say.getAttribute('role') === 'status',
      figureHidden: !!fig && fig.getAttribute('aria-hidden') === 'true',
      soundNamed: !!snd && !!(snd.getAttribute('aria-label') || '').trim(),
      soundPressed: !!snd && snd.hasAttribute('aria-pressed'),
      soundDefaultOff: !!snd && snd.getAttribute('aria-pressed') === 'false',
    };
  });
  ok(dealer.sayLive, 'table: what the dealer says is announced, not just drawn');
  ok(dealer.figureHidden, 'table: the dealer figure is decorative and hidden from the reader');
  ok(dealer.soundNamed, 'table: the sound control has a name, not just a glyph');
  ok(dealer.soundPressed, 'table: the sound control reports whether it is on');
  ok(dealer.soundDefaultOff, 'table: sound is off until asked for');

  /* The deal animation is not asserted here. Seeing it needs animationstart
     on a real deal, and the honest ways to get one from this page are to
     expose render or to drive the table from outside — both more machinery
     than the check is worth. It is covered by hand instead; a stub that
     counted nothing would just read like coverage. */

  await t.close();
  server.close();
}

/* ------------------------------------------------------------ touch targets */
/* A fingertip covers far more ground than a cursor, so controls a mouse hits
   easily can be genuinely hard to tap. Measured the way a finger meets them:
   hit-test outward from each control's centre and see how big the region that
   actually activates it is -- a padded-out hit area counts, and a control
   sitting under an overlay does not, neither of which a bounding box shows. */
{
  const m = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.goto(APP_URL);
  await m.waitForTimeout(400);

  const worst = new Map();
  for (const v of VIEWS) {
    await m.click(`#nav button[data-view="${v}"]`);
    await m.waitForTimeout(250);
    const found = [];
    const pageHeight = await m.evaluate(() => document.documentElement.scrollHeight);
    // Hit-testing only works on what is currently on screen, so walk the view
    // down a screen at a time. Without this a control passes the moment it
    // happens to sit below the fold, which is an accident, not a result.
    for (let y = 0; y < pageHeight; y += 700) {
      await m.evaluate(top => window.scrollTo(0, top), y);
      await m.waitForTimeout(120);
      found.push(...await m.evaluate(() => {
      const name = el => {
        const par = el.parentElement;
        return el.id ? el.tagName.toLowerCase() + '#' + el.id
          : (par ? par.tagName.toLowerCase() + '.' + (par.className || '').toString().trim().split(' ')[0] + ' > ' : '')
            + el.tagName.toLowerCase() + '.' + (el.className || '').toString().trim().split(' ')[0];
      };
      const mine = (el, x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); };
      // A control inside a deliberately scrollable box is clipped by design --
      // you scroll to reach it. That is not the same as being too small.
      const clipped = el => {
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const st = getComputedStyle(a);
          if (!/auto|scroll/.test(st.overflowX + st.overflowY)) continue;
          const ab = a.getBoundingClientRect(), eb = el.getBoundingClientRect();
          if (eb.left < ab.left - 1 || eb.right > ab.right + 1 || eb.top < ab.top - 1 || eb.bottom > ab.bottom + 1) return true;
        }
        return false;
      };
      const out = [];
      document.querySelectorAll('button,a[href],[role=button],input,select').forEach(el => {
        if (!el.offsetParent) return;
        // A checkbox wrapped in its label is tapped by hitting the label, so
        // the label is the target a finger actually aims at -- measuring the
        // 20px box would report a problem the page does not have.
        const hit = el.tagName === 'INPUT' && el.closest('label') ? el.closest('label') : el;
        const bx = hit.getBoundingClientRect();
        if (!bx.width || !bx.height) return;
        // Only what is fully on screen can be hit-tested at all.
        if (bx.top < 0 || bx.bottom > window.innerHeight || bx.left < 0 || bx.right > window.innerWidth) return;
        const cx = bx.x + bx.width / 2, cy = bx.y + bx.height / 2;
        // Covered dead centre: taps aimed at this control land on something
        // else entirely. Record it rather than skipping, or a control that is
        // completely buried would pass by never being measured at all.
        if (!mine(hit, cx, cy)) { out.push({ name: name(el), w: 0, h: 0, taken: 25, buried: true,
                                            clipped: clipped(el), box: Math.round(bx.width) + 'x' + Math.round(bx.height) }); return; }
        // Is any of the control's own painted box covered by something above it?
        let taken = 0;
        for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++)
          if (!mine(hit, bx.x + bx.width * i / 6, bx.y + bx.height * j / 6)) taken++;
        // Past 61px the answer to "is it at least 44?" is already yes.
        const reach = (dx, dy) => { for (let d = 1; d <= 30; d++) if (!mine(hit, cx + dx * d, cy + dy * d)) return d - 1; return 30; };
        out.push({ name: name(el), w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1,
                   taken, clipped: clipped(hit), box: Math.round(bx.width) + 'x' + Math.round(bx.height) });
      });
      return out;
      }));
    }
    await m.evaluate(() => window.scrollTo(0, 0));
    for (const r of found) {
      const seen = worst.get(r.name);
      if (!seen || Math.min(r.w, r.h) < Math.min(seen.w, seen.h)) worst.set(r.name, r);
    }
  }

  const all = [...worst.values()];
  // Guard against a vacuous pass: if the sweep found nothing, it proved nothing.
  ok(all.length > 25, `touch: enough controls were measured to mean something (${all.length})`);

  // The map pins are laid out in map coordinates on a surface you can pan and
  // zoom, so one can sit against the map's edge or under the reset-view button.
  // Everything that flows in the page layout has no such excuse.
  const pin = r => r.name.endsWith('button.node');
  // Strategy chart cells stay at their grid size on purpose. The chart is
  // eleven columns wide; a 44px cell would either run off a phone screen or
  // force a second axis of scrolling to read one square. A cell only opens an
  // explainer, and both the chart and that explainer are reachable by keyboard.
  const chartCell = r => / > td\.act-/.test(r.name);
  const small = all.filter(r => !r.clipped && !pin(r) && !chartCell(r) && !r.buried && (r.w < 44 || r.h < 44));
  ok(small.length === 0,
     `touch: every control is at least 44px to a finger (${small.map(r => `${r.name} ${r.w}x${r.h}`).slice(0, 5).join(', ')})`);

  // A hit region smaller than the painted box means something is sitting on
  // top and swallowing taps meant for this control.
  const stolen = all.filter(r => r.taken > 0 && !r.clipped && !pin(r) && !chartCell(r) && !r.buried);
  ok(stolen.length === 0,
     `touch: no control has its taps stolen by an overlay (${stolen.map(r => `${r.name} ${r.taken}/25 of ${r.box}`).slice(0, 5).join(', ')})`);

  const buried = all.filter(r => r.buried && !r.clipped && !pin(r) && !chartCell(r));
  ok(buried.length === 0,
     `touch: no control is buried under another element (${buried.map(r => `${r.name} ${r.box}`).slice(0, 5).join(', ')})`);

  /* The nav scrolls sideways at this width, and arriving straight at a view
     used to leave the selected tab off the end of it — you could not see which
     screen you were on. Moving focus scrolls a tab into view by itself, which
     is why the arrow keys never showed this; these arrive by URL instead. */
  for (const view of ['dashboard', 'analyzer', 'course']) {
    await m.goto(APP_URL + '#' + view);
    await m.waitForTimeout(400);
    const r = await m.evaluate(() => {
      const nav = document.getElementById('nav');
      const tab = nav.querySelector('button.active');
      if (!tab) return { ok: false, why: 'no tab is marked selected' };
      const nb = nav.getBoundingClientRect(), tb = tab.getBoundingClientRect();
      return { ok: tb.left >= nb.left - 1 && tb.right <= nb.right + 1,
               why: `"${tab.textContent}" sits ${Math.round(tb.left - nb.left)}px from the nav's left edge, ` +
                    `${Math.round(tb.right - nb.right)}px from its right` };
    });
    ok(r.ok, `touch: landing on #${view} shows which tab is selected (${r.why})`);
    /* There was a check here that the page had not scrolled. It could not
       fail: showView scrolls to the top on every call, so scrollY is zero
       whatever this code does, and the assertion was testing that other line
       rather than this one. */
  }
  await m.goto(APP_URL);
  await m.waitForTimeout(300);

  // The page must not be wider than the phone. Comparing scrollWidth against
  // innerWidth alone cannot catch this: faced with content it cannot fit, the
  // browser widens the layout viewport and zooms out instead of scrolling, so
  // the two stay equal and everything just gets smaller. The device width is
  // the fixed thing to measure against.
  const width = await m.evaluate(() => ({ layout: window.innerWidth, content: document.documentElement.scrollWidth }));
  ok(width.layout <= 390 && width.content <= 391,
     `touch: the page fits a 390px phone (layout viewport ${width.layout}px, content ${width.content}px)`);

  await m.close();
}

/* --------------------------------------------------- thumb-zone action dock */
/* On a phone the drill's decisions are docked to the bottom of the screen, so
   they are under your thumb rather than at the top of a page you have already
   scrolled. Three things can go wrong and none of them show on a desktop:
   the bar stops being pinned, six buttons stop fitting the width, or the bar
   covers the control you need next. Measured at the three widths phones
   actually are, in each drill, with a hand in progress so the bar is real. */
{
  const MODES = [
    ['basic',      '#basicMode',      '#basicActions [data-a]', '#basicNext'],
    ['deviation',  '#deviationMode',  '#devActions [data-d]',   '#devNext'],
  ];
  for (const w of [390, 360, 320]) {
    const d = await b.newPage({ viewport: { width: w, height: 740 }, isMobile: true, hasTouch: true });
    await d.goto(APP_URL);
    await d.waitForTimeout(350);
    // Auto-advance would whisk the hand away before the Next control could be
    // looked at, and it is the control most at risk of ending up under the bar.
    await d.uncheck('#prefAuto');

    for (const [mode, panel, buttons, next] of MODES) {
      await d.click(`[data-mode="${mode}"]`);
      await d.waitForTimeout(300);

      const r = await d.evaluate(([panel, buttons]) => {
        const bar = document.querySelector(panel + ' .actions');
        const bx = bar.getBoundingClientRect();
        const btns = [...document.querySelectorAll(buttons)];
        return {
          position: getComputedStyle(bar).position,
          gapToBottom: Math.round(window.innerHeight - bx.bottom),
          count: btns.length,
          // A button whose own text is wider than the box it sits in has its
          // label cut off. Measured on the element that holds the text, since
          // the button itself stretches to whatever flex gives it.
          clipped: btns.filter(x => x.scrollWidth > x.clientWidth + 1)
                       .map(x => `${x.textContent.trim()} ${x.scrollWidth}>${x.clientWidth}`),
          short: btns.filter(x => x.getBoundingClientRect().height < 44)
                     .map(x => `${x.textContent.trim()} ${Math.round(x.getBoundingClientRect().height)}px`),
          // Two buttons sharing pixels is a mis-tap waiting to happen.
          overlapping: btns.some((x, i) => btns.slice(i + 1).some(y => {
            const a = x.getBoundingClientRect(), c = y.getBoundingClientRect();
            return a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1;
          })),
          // The page's own scrollWidth is no use here: a fixed element that
          // overflows does not extend the document's scroll area at all, so
          // that number stays exactly 390 while buttons run off both edges.
          // Measured on the bar, and on where the buttons actually land.
          barOverflow: bar.scrollWidth - bar.clientWidth,
          outside: btns.filter(x => {
            const q = x.getBoundingClientRect();
            return q.left < -1 || q.right > window.innerWidth + 1;
          }).map(x => x.textContent.trim()),
          content: document.documentElement.scrollWidth,
          layout: window.innerWidth,
        };
      }, [panel, buttons]);

      ok(r.position === 'fixed' && r.gapToBottom === 0,
         `dock: ${mode} at ${w}px is pinned to the bottom of the screen (${r.position}, ${r.gapToBottom}px short)`);
      ok(r.count >= 5, `dock: ${mode} at ${w}px actually has its buttons to measure (${r.count})`);
      ok(r.clipped.length === 0,
         `dock: ${mode} at ${w}px shows every label in full (${r.clipped.join(', ')})`);
      ok(r.short.length === 0,
         `dock: ${mode} at ${w}px keeps every button 44px tall (${r.short.join(', ')})`);
      ok(!r.overlapping, `dock: ${mode} at ${w}px keeps its buttons apart`);
      ok(r.barOverflow <= 1 && r.outside.length === 0,
         `dock: ${mode} at ${w}px keeps every button on the screen ` +
         `(${r.barOverflow}px over, off the edge: ${r.outside.join(', ') || 'none'})`);
      ok(r.layout <= w && r.content <= w + 1,
         `dock: ${mode} at ${w}px does not push the page sideways (layout ${r.layout}, content ${r.content})`);

      // Answer the hand, then look for the control that appears in its place.
      // A fixed bar takes its space out of the flow, and if that space is not
      // given back the page simply ends underneath it.
      // Reported rather than thrown: if a button has ended up somewhere a
      // finger cannot reach it, that is a result, and a run that dies here
      // prints no failures at all -- including the ones already found.
      const stood = await d.click(`${buttons}[data-${mode === 'basic' ? 'a' : 'd'}="STAND"]`,
                                  { timeout: 4000 }).then(() => true, () => false);
      ok(stood, `dock: ${mode} at ${w}px lets a tap reach the Stand button`);
      await d.waitForTimeout(300);
      ok(await d.evaluate(n => { const e = document.querySelector(n); return !!e && !e.hidden; }, next),
         `dock: ${mode} at ${w}px offers a Next control after a hand`);

      /* The bar is taken out of the flow, so whatever room it covers has to
         be given back or the page simply ends underneath it. These drills are
         all shorter than a phone screen, which means nothing ever reaches the
         bottom and any comparison of real content against the bar passes on
         its own -- so the page is given content that does overflow, and the
         last line of it is hit-tested where it lands. A drill whose feedback
         runs long is exactly this case. */
      const room = await d.evaluate(panel => {
        const panelEl = document.querySelector(panel);
        const probe = document.createElement('div');
        probe.id = '__tall';
        probe.style.cssText = 'height:1400px;display:flex;align-items:flex-end';
        probe.innerHTML = '<span id="__last" style="display:block;height:20px">last line</span>';
        // Appended as the panel's very last child, so the only thing between
        // it and the bar is whatever room the panel reserves. Put anywhere
        // else, the feedback line and the Next bar below it supply clearance
        // of their own and the check passes without testing anything.
        panelEl.append(probe);
        window.scrollTo(0, document.documentElement.scrollHeight);
        const last = document.getElementById('__last').getBoundingClientRect();
        const hit = document.elementFromPoint(last.x + last.width / 2, last.y + last.height / 2);
        const covered = !(hit && hit.id === '__last');
        const offscreen = last.bottom > window.innerHeight + 1;
        probe.remove();
        return { covered, offscreen, bottom: Math.round(last.bottom), h: window.innerHeight };
      }, panel);
      ok(!room.covered && !room.offscreen,
         `dock: ${mode} at ${w}px leaves room below the bar for the end of a long drill ` +
         `(covered ${room.covered}, ends at ${room.bottom} of ${room.h})`);

      await d.click(`${panel} [data-back]`);
      await d.waitForTimeout(250);
    }

    /* Simulation is the same bar but you have to be in a hand for it to exist,
       and it is the one screen where a hand can end the moment it is dealt. */
    await d.click('[data-mode="simulation"]');
    await d.waitForTimeout(300);
    /* A deal can resolve on the spot — a natural, or a dealer blackjack — and
       then there is no turn and no bar to measure. Deal again until there is
       one: skipping would leave this passing without having looked. */
    // At the default $25 a hand the bankroll runs out after twenty deals, and
    // then the loop below stops for want of money rather than for want of a
    // hand. A dollar a hand leaves far more attempts than it can ever need.
    await d.fill('#simBet', '1');
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await d.locator('#simActions').isVisible()) break;
      // A dealer ace stops on the insurance question, where neither the Deal
      // button nor the action bar is on screen. Declining moves the hand on;
      // treating that state as "no hand to be had" is what made this skip.
      if (await d.locator('#simInsure').isVisible()) {
        await d.click('#simInsure [data-i="no"]');
        await d.waitForTimeout(220);
        continue;
      }
      if (!await d.locator('#simDeal').isVisible()) break;
      await d.click('#simDeal');
      await d.waitForTimeout(220);
    }
    const sim = await d.evaluate(w => {
      const bar = document.getElementById('simActions');
      if (bar.hidden) return { skipped: true };
      const bx = bar.getBoundingClientRect();
      const btns = [...bar.querySelectorAll('[data-s]')];
      return {
        pinned: getComputedStyle(bar).position === 'fixed' && Math.round(window.innerHeight - bx.bottom) === 0,
        count: btns.length,
        clipped: btns.filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.textContent.trim()),
        outside: btns.filter(x => {
          const q = x.getBoundingClientRect();
          return q.left < -1 || q.right > window.innerWidth + 1;
        }).map(x => x.textContent.trim()),
        content: document.documentElement.scrollWidth,
      };
    }, w);
    ok(!sim.skipped, `dock: simulation at ${w}px reached a hand to measure`);
    if (!sim.skipped) {
      ok(sim.pinned, `dock: simulation at ${w}px is pinned to the bottom of the screen`);
      ok(sim.count === 5, `dock: simulation at ${w}px has its five actions (${sim.count})`);
      ok(sim.clipped.length === 0, `dock: simulation at ${w}px shows every label in full (${sim.clipped.join(', ')})`);
      ok(sim.outside.length === 0,
         `dock: simulation at ${w}px keeps every button on the screen (${sim.outside.join(', ')})`);
    }

    await d.close();
  }

  /* And the other half of the claim: a mouse is not a thumb. The dock is
     scoped to coarse pointers, so the desktop layout must be untouched -- the
     bar stays in the flow, and the full word and the keyboard hint stay on. */
  const desk = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await desk.goto(APP_URL);
  await desk.waitForTimeout(300);
  await desk.click('[data-mode="basic"]');
  await desk.waitForTimeout(300);
  const dk = await desk.evaluate(() => {
    const bar = document.querySelector('#basicMode .actions');
    const surr = bar.querySelector('[data-a="SURRENDER"]');
    return { position: getComputedStyle(bar).position,
             label: surr.textContent.replace(/\s+/g, ' ').trim(),
             kbd: getComputedStyle(surr.querySelector('kbd')).display };
  });
  ok(dk.position === 'static', `desktop: the action bar is not docked (${dk.position})`);
  ok(/Surrender/.test(dk.label) && !/^Surr\b/.test(dk.label),
     `desktop: the button still says Surrender in full (${dk.label})`);
  ok(dk.kbd !== 'none', `desktop: the keyboard hint is still shown (${dk.kbd})`);
  await desk.close();
}

await b.close();

console.log(`accessibility checks run: ${checks}`);
if (fails.length) {
  console.log('A11Y FAILURES:');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('all accessibility checks passed');
