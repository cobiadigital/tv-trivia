// Drives a game using only mouse and touch, asserting that pointer input
// reaches every action the remote can and that a stray tap commits nothing.
//
//   npm run test:pointer
//
// Needs Playwright and a Chromium build, which are deliberately NOT project
// dependencies - installing them would slow every Cloudflare deploy for a test
// that only runs locally. Without them this exits 0 with a note.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright not installed - skipping pointer tests');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

let breakQuestions = false;      // flipped by the boot tests below

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (breakQuestions && path.indexOf('questions.json') !== -1) {
    res.writeHead(500).end('deliberately broken');
    return;
  }
  try {
    const body = await readFile(join(PUBLIC, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const expect = (cond, msg) => {
  if (cond) console.log('  ok   ' + msg);
  else { failures.push(msg); console.log('  FAIL ' + msg); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base, { waitUntil: 'networkidle' });

const screen = () => page.evaluate(() => currentScreen());
const state = (fn) => page.evaluate(fn);
const chip = (label) => page.locator(`.hint-key:text-is("${label}")`).first();

console.log('pointer input');

// Everything below is pointer-only: no key is pressed at any point.
await chip('OK').click();
expect(await screen() === 'setupCount', 'the OK chip advances the attract screen');

await page.locator('.tile:text-is("2")').click();
expect(await state(() => setup.count) === 2, 'tapping a count tile selects it');
expect(await screen() === 'setupCount', 'one tap does not confirm the count');
await page.locator('.tile:text-is("2")').click();
expect(await screen() === 'setupName', 'a second tap confirms the count');

// The name field is focused on arrival, which is what raises the TV's keyboard.
expect(await state(() => document.activeElement.id) === 'namefield',
  'the name field takes focus on arrival');
await page.locator('#namefield').fill('Jo');
expect(await state(() => setup.names[0]) === 'Jo', 'typing updates the stored name');
expect(await state(() => document.activeElement.id) === 'namefield',
  'typing does not re-render and steal focus');
await chip('OK').click();
expect(await state(() => setup.playerIdx) === 1, 'the OK chip moves to the next player');
expect(await state(() => document.activeElement.id) === 'namefield',
  'the next player field takes focus too');

// Down is the fallback for TV browsers that keep Enter for their own keyboard.
await chip('\u2191').click();
expect(await state(() => setup.playerIdx) === 0, 'the up chip goes back a player');
expect(await state(() => setup.names[0]) === 'Jo', 'going back keeps the typed name');
await page.locator('#namefield').press('ArrowDown');
expect(await state(() => setup.playerIdx) === 1, 'Down in the field advances a player');

// Enter, where the browser delivers it rather than opening its own keyboard.
await page.locator('#namefield').fill('Sam');
await page.keyboard.press('Enter');
expect(await screen() === 'draft', 'Enter in the field finishes setup');
expect(await state(() => S.players.map((p) => p.name).join(',')) === 'Jo,Sam',
  'both typed names reached the game');

// The cursor already sits on the first tile when the draft opens, so this is
// the case that would misfire if arming keyed off cursor position.
await page.locator('.tile').first().click();
expect(await state(() => S.draft.vetoed.length) === 0, 'one tap on a category does not veto it');
await page.locator('.tile').first().click();
expect(await state(() => S.draft.vetoed.length) === 1, 'a second tap vetoes it');
expect(await page.locator('.tile.gone').first().getAttribute('data-pick') === null,
  'a vetoed category is not tappable');
while (await screen() === 'draft') await page.locator('.tile.tappable').first().click();
expect(await screen() === 'sectionIntro', 'the draft completes by pointer');

await chip('OK').click();
await page.locator('.tile:text-is("3")').click();
expect(await screen() === 'wager', 'one tap does not commit a wager');
await page.locator('.tile:text-is("3")').click();
expect(await state(() => S.q.value) === 3, 'a second tap wagers the tapped value');

expect(await state(() => S.q.revealed) === 0, 'the question starts with nothing revealed');
await page.locator('.opt.hidden').first().click();
expect(await state(() => S.q.revealed) === 1, 'tapping the next slot reveals it');
await chip('OK').click();
expect(await state(() => S.q.revealed) === 2, 'the OK chip reveals the next option');

await page.locator('.opt').first().click();
expect(await state(() => S.q.sel) === 0, 'tapping a revealed option selects it');
expect(await screen() === 'question', 'one tap does not lock an answer');
await page.locator('.opt').nth(1).click();
expect(await state(() => S.q.sel) === 1, 'tapping another option moves the selection');
await page.locator('.opt').nth(1).click();
expect(await state(() => S.q.lockedIdx) === 1, 'a second tap locks the selected answer');

// An arming must belong to the thing that was on screen when it was made.
await state(() => { S.screen = 'wager'; S.wagerCursor = 0; render(); });
await page.locator('.tile.tappable').first().click();
await state(() => { S.turn = (S.turn + 1) % S.order.length; render(); });
await page.locator('.tile.tappable').first().click();
expect(await screen() === 'wager', 'an arming does not carry across a turn change');

await state(() => { S.screen = 'judge'; render(); });
await chip('Back').click();
expect(await screen() === 'question', 'the Back chip undoes a judgment');

const before = await state(() => JSON.stringify(S));
await page.locator('.question').click();
await page.locator('body').click({ position: { x: 5, y: 400 } });
expect(await state(() => JSON.stringify(S)) === before, 'clicking dead space changes nothing');

// Touch, on a phone-sized viewport.
const touch = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
const tp = await touch.newPage();
await tp.goto(base, { waitUntil: 'networkidle' });
await tp.locator('.hint-key:text-is("OK")').first().tap();
expect(await tp.evaluate(() => currentScreen()) === 'setupCount', 'a touch tap drives the game');

const tooSmall = await tp.evaluate(() => {
  const bad = [];
  document.querySelectorAll('[data-act],[data-pick],[data-key]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height < 32 || r.width < 32) {
      bad.push(`${el.textContent.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  });
  return bad;
});
expect(tooSmall.length === 0, 'every touch target clears 32px: ' + JSON.stringify(tooSmall));
await touch.close();
expect(errors.length === 0, 'no page errors: ' + errors.join('; '));
// ---------------------------------------------------------------- small screens

// Playwright ships no iPhone 17 Pro profile, so bracket it: the 15 Pro is
// narrower and shorter, the Pro Max wider, and the middle entry is the 17 Pro's
// reported 402pt width with room taken off for Safari's chrome.
const VIEWPORTS = [
  ['iPhone 15 Pro', 393, 659],
  ['iPhone 17 Pro', 402, 734],
  ['iPhone 17 Pro Max', 440, 782],
  ['iPhone 17 Pro landscape', 874, 402],
  ['iPhone 15 Pro landscape', 734, 393],
  ['small Android', 360, 640],
  ['small Android landscape', 640, 360],
];

console.log('\nsmall screens');

for (const [label, width, height] of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  const sp = await ctx.newPage();
  const perr = [];
  sp.on('pageerror', (e) => perr.push(e.message));
  await sp.goto(base, { waitUntil: 'networkidle' });

  // Walk to a question, the densest screen in the game.
  await sp.evaluate(() => {
    handle('OK'); handle('OK');
    setup.names = ['Alexandra', 'Bo']; setup.count = 2;
    handle('OK'); handle('OK');
    while (currentScreen() === 'draft') handle('OK');
    handle('OK');
    handle('OK');
    // Pin worst-case content: otherwise this test passes or fails on whichever
    // question the bank happened to deal.
    S.q.text = 'Which of these long-winded and thoroughly padded questions is ' +
      'the one that wraps onto several lines on a small screen?';
    S.q.options = [0, 1, 2, 3].map((n) => 'A thoroughly padded answer option ' + n);
    S.q.correctIdx = 0;
    S.q.revealed = 4;
    render();
  });

  const m = await sp.evaluate(() => {
    const doc = document.documentElement;
    const hints = document.querySelector('.hints').getBoundingClientRect();
    const small = [];
    document.querySelectorAll('[data-act],[data-pick]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 32 || r.height < 32) small.push(el.textContent.trim());
    });
    const style = getComputedStyle(document.body);
    const scroller = document.querySelector('.screen-scroll');
    return {
      contentOverflow: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
      rootSize: getComputedStyle(document.documentElement).fontSize,
      overflowX: doc.scrollWidth - doc.clientWidth,
      clipped: doc.scrollHeight > doc.clientHeight && style.overflowY !== 'auto',
      hintsOnScreen: hints.bottom <= doc.clientHeight + 1 && hints.top >= 0,
      questionSize: parseFloat(getComputedStyle(document.querySelector('.question')).fontSize),
      padTop: parseFloat(style.paddingTop),
      small,
      screen: currentScreen(),
    };
  });

  expect(m.screen === 'question', `${label}: reaches a question`);
  // The board is shrunk to fit rather than left to scroll: on a phone held
  // sideways half of it used to sit below the fold.
  expect(m.contentOverflow <= 1,
    `${label}: the whole board fits without scrolling ` +
    `(over by ${m.contentOverflow}px at root ${m.rootSize})`);
  expect(m.overflowX === 0, `${label}: no horizontal overflow (${m.overflowX}px)`);
  expect(!m.clipped, `${label}: overflowing content scrolls instead of being clipped`);
  expect(m.hintsOnScreen, `${label}: the control bar stays on screen`);
  expect(m.questionSize >= 16 && m.questionSize <= 40,
    `${label}: question text is legible but fits (${m.questionSize}px)`);
  expect(m.small.length === 0, `${label}: touch targets clear 32px ${JSON.stringify(m.small)}`);
  expect(perr.length === 0, `${label}: no page errors`);

  // The guarantee is twofold, and the split matters. Anything drawn clear of the
  // control bar must answer a tap where it sits - that is what broke when the
  // bar was sticky, leaving the last option lying underneath it, opaque and
  // dead. Anything the bar does overlap must still be reachable by scrolling;
  // on the smallest screens the longest questions genuinely do not fit, and
  // scrolling to them is ordinary, but silently swallowing a tap is not.
  const clear = await sp.evaluate(() => {
    const bar = document.querySelector('.hints').getBoundingClientRect();
    const bad = [];
    document.querySelectorAll('[data-act],[data-pick]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > bar.top + 1) return;      // not drawn clear
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(hit === el || el.contains(hit))) {
        bad.push(`${(el.textContent || '').trim().slice(0, 18)} under ${hit ? hit.className : 'nothing'}`);
      }
    });
    return bad;
  });
  expect(clear.length === 0,
    `${label}: everything drawn clear of the control bar is tappable ${JSON.stringify(clear)}`);

  // A real finger taps where the thing is now. Playwright's .tap() scrolls it
  // into view first, which is exactly how the original bug went unnoticed - so
  // tap by raw coordinates for the at-rest check.
  const optionCount = await sp.evaluate(() => document.querySelectorAll('.opt').length);
  const dead = [];
  let needScroll = 0;
  for (let i = 0; i < optionCount; i++) {
    await sp.evaluate(() => { S.q.sel = null; render(); });
    const box = await sp.evaluate((idx) => {
      const r = document.querySelectorAll('.opt')[idx].getBoundingClientRect();
      const bar = document.querySelector('.hints').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, clear: r.bottom <= bar.top + 1 };
    }, i);
    if (box.clear) {
      await sp.touchscreen.tap(box.x, box.y);
      if (await sp.evaluate(() => S.q.sel) !== i) dead.push(`option ${i} tapped at rest -> nothing`);
    } else {
      needScroll++;
      await sp.locator('.opt').nth(i).tap();          // scrolls, then taps
      if (await sp.evaluate(() => S.q.sel) !== i) dead.push(`option ${i} unreachable even scrolled`);
    }
  }
  expect(dead.length === 0, `${label}: every option answers a finger ${JSON.stringify(dead)}`);
  if (needScroll) console.log(`       (${needScroll} of ${optionCount} options need a scroll here)`);

  await ctx.close();
}

// ------------------------------------------------------------- number keys

// The LG Magic Remote moves a pointer with its D-pad and webOS keeps the arrow
// keys for itself, so numbers may be the only keys that reach the page. Every
// screen with a list has to be drivable by them alone.
console.log('\nnumber keys');

{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });

  const at = () => page.evaluate(() => currentScreen());
  const read = (fn) => page.evaluate(fn);
  const key = (k) => page.keyboard.press(k);

  expect(await read(() => document.getElementById('lastkey').textContent) === '',
    'the key readout is blank until a key arrives');
  await key('3');
  expect(/3 \u00b7 51/.test(await read(() => document.getElementById('lastkey').textContent)),
    'the key readout names the key and its code, since a TV has no console');

  await key('Enter');
  await key('2');
  expect(await at() === 'setupName' && await read(() => setup.count) === 2,
    'a number picks the player count outright');

  await key('Enter'); await key('Enter');
  expect(await at() === 'draft', 'reached the draft');
  // Walk up the list: a number for an already-vetoed category is correctly
  // ignored, so pressing the same one twice would spin here for ever.
  for (let n = 1; n <= 9 && await at() === 'draft'; n++) await key(String(n));
  expect(await at() === 'sectionIntro', 'the whole draft is drivable by number');

  await key('Enter');
  await key('3');
  expect(await at() === 'question' && await read(() => S.q.value) === 3,
    'on the wager screen the number is the wager, not a position');

  // Nothing may be locked before it has been revealed.
  await key('2');
  expect(await at() === 'question' && await read(() => S.q.lockedIdx) === null,
    'a number for an unrevealed option is ignored');
  await key('Enter'); await key('Enter');
  await key('4');
  expect(await at() === 'question', 'still ignored with only A and B showing');
  await key('2');
  expect(await at() === 'judge' && await read(() => S.q.lockedIdx) === 1,
    'pressing 2 locks option B');
  await key('Backspace');
  expect(await at() === 'question', 'Back undoes a mis-keyed number');

  // Digits type a multi-digit final wager rather than stepping to it.
  await page.evaluate(() => { startFinal(); render(); handle('OK'); });
  await key('1'); await key('2');
  expect(await read(() => S.final.wagerValue) === 12, 'digits build a two-digit wager');
  await key('0');
  expect(await read(() => S.final.wagerValue) === 0, 'and 0 clears an overshoot');

  expect(errs.length === 0, `no page errors driving by number ${JSON.stringify(errs)}`);
  await ctx.close();
}

// ------------------------------------------------------------ link browsing

// Samsung televisions offer "link browsing", where the D-pad walks the
// browser's own focus between focusable elements rather than driving a
// pointer. Nothing here was focusable, so it found no controls at all and fell
// back to selecting the single element that had a click handler - the block
// wrapping the whole screen.
console.log('\nlink browsing');

{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });

  const at = () => page.evaluate(() => currentScreen());

  const reachable = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[data-act],[data-pick]')];
    return { count: all.length, allFocusable: all.every((el) => el.tabIndex >= 0) };
  });
  expect(reachable.count > 0 && reachable.allFocusable,
    `every control is reachable by focus (${reachable.count} on the attract screen)`);

  // Tab is what a link-browsing D-pad does: move the browser's own focus.
  await page.keyboard.press('Tab');
  const landed = await page.evaluate(() => {
    const el = document.activeElement;
    return !!(el && el.getAttribute && (el.getAttribute('data-act') || el.getAttribute('data-pick')));
  });
  expect(landed, 'focus lands on a control rather than the page body');

  // A div with role=button is not activated by Enter the way a real button is,
  // so the app has to do it - exactly once.
  await page.keyboard.press('Enter');
  expect(await at() === 'setupCount', 'Enter on a focused control fires once, not twice');

  await page.evaluate(() => { document.querySelector('[data-pick="0"]').focus(); });
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => setup.count) === 2 && await at() === 'setupName',
    'a deliberately focused control commits on one press, unlike a pointer tap');

  // Re-rendering replaces every node; without restoring focus, link browsing
  // would be thrown back to the top of the screen after every press.
  await page.evaluate(() => { handle('OK'); handle('OK'); });
  const kept = await page.evaluate(() => {
    const first = document.querySelector('[data-pick]');
    first.focus();
    const before = first.getAttribute('data-pick');
    render();
    const now = document.activeElement;
    return !!(now && now.getAttribute && now.getAttribute('data-pick') === before);
  });
  expect(kept, 'focus survives a re-render');

  // The pointer model must be untouched by any of this.
  await page.evaluate(() => { while (currentScreen() === 'draft') handle('OK'); handle('OK'); });
  await page.locator('.tile.tappable').first().click();
  expect(await at() === 'wager', 'a mouse click still selects rather than committing');

  expect(errs.length === 0, `no page errors under link browsing ${JSON.stringify(errs)}`);
  await ctx.close();
}

// ----------------------------------------------------------- other screens

// The fit checks above all measure a question. The category draft is a
// different shape - a list of long names, nine of them at most - and stacked
// one per row it could not be made to fit sideways at any type size.
console.log('\nother screens fit too');

for (const [label, width, height] of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  const sp = await ctx.newPage();
  await sp.goto(base, { waitUntil: 'networkidle' });

  // Four players in section 2 is the largest pool the game ever draws: nine.
  const draft = await sp.evaluate(() => {
    handle('OK'); handle('OK');
    setup.names = ['Alexandra', 'Bartholomew', 'Cassiopeia', 'Demetrius'];
    setup.count = 4;
    for (let i = 0; i < 4; i++) handle('OK');
    S.sectionIndex = 1;
    startDraft();
    render();
    const scroller = document.querySelector('.screen-scroll');
    const tiles = [...document.querySelectorAll('.tile')];
    return {
      screen: currentScreen(),
      pool: tiles.length,
      over: scroller.scrollHeight - scroller.clientHeight,
      shortest: Math.min(...tiles.map((t) => Math.round(t.getBoundingClientRect().height))),
      narrowest: Math.min(...tiles.map((t) => Math.round(t.getBoundingClientRect().width))),
    };
  });
  expect(draft.screen === 'draft' && draft.pool === 9,
    `${label}: the biggest draft pool is nine categories (got ${draft.pool})`);
  expect(draft.over <= 1,
    `${label}: the whole category draft fits (over by ${draft.over}px)`);
  expect(draft.shortest >= 32 && draft.narrowest >= 32,
    `${label}: category tiles stay hittable (${draft.narrowest}x${draft.shortest})`);

  // Sudden death lays out the same wide tile, with a player on each.
  const sudden = await sp.evaluate(() => {
    S.players.forEach((p) => { p.score = 10; });
    finishGame();
    S.sudden.revealed = true;
    render();
    const scroller = document.querySelector('.screen-scroll');
    return { screen: currentScreen(), over: scroller.scrollHeight - scroller.clientHeight };
  });
  expect(sudden.screen === 'sudden' && sudden.over <= 1,
    `${label}: sudden death fits (over by ${sudden.over}px)`);

  await ctx.close();
}

// --------------------------------------------------------------------- boot

// A television has no console. Every one of these paths used to end in a screen
// reading "Loading questions" with nothing further to say.
console.log('\nboot');

async function boot(opts) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  if (opts && opts.noFetch) {
    // Stand in for a webOS engine old enough to have no fetch at all.
    await page.addInitScript(() => {
      try { delete window.fetch; } catch (e) { window.fetch = undefined; }
    });
  }
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  const state = await page.evaluate(() => ({
    screen: currentScreen(),
    fetchType: typeof fetch,
    text: document.getElementById('screen').textContent,
  }));
  await ctx.close();
  return { state, errs };
}

{
  let r = await boot();
  expect(r.state.screen === 'attract', 'a normal load reaches the attract screen');
  expect(r.errs.length === 0, `no page errors on a normal load ${JSON.stringify(r.errs)}`);

  r = await boot({ noFetch: true });
  expect(r.state.fetchType === 'undefined', 'the no-fetch engine really has no fetch');
  expect(r.state.screen === 'attract', 'it still loads with no fetch at all');
  expect(r.errs.length === 0, `no page errors without fetch ${JSON.stringify(r.errs)}`);

  breakQuestions = true;
  r = await boot();
  breakQuestions = false;
  expect(r.state.screen === 'error', 'a failing questions.json reaches the error screen, not a hang');
  expect(/HTTP 500/.test(r.state.text), 'the error screen says what happened');
  expect(/Mozilla|Chrome|AppleWebKit/.test(r.state.text),
    'the error screen reports the user agent, since there is no console to ask');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.onerror('Boom went the engine', 'app.js', 42); });
  const text = await page.evaluate(() => document.getElementById('screen').textContent);
  expect(/Something went wrong/.test(text) && /Boom went the engine/.test(text),
    'a thrown error is painted on screen rather than dying silently');
  expect(/line 42/.test(text), 'and says where it came from');
  await ctx.close();
}

// -------------------------------------------------------------- the app shell

// The bug this guards: a control bar that overlapped the content it was meant
// to sit beside, in an arrangement (fixed bar, body-scrolled page, height
// measured in script) that behaves differently in a standalone PWA window.
console.log('\napp shell');

{
  const css = (await readFile(new URL('../public/style.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');          // the comments discuss both by name
  expect(!/position:\s*fixed/.test(css), 'no element is position:fixed');
  expect(!/--hints-height/.test(css), 'no height is measured in script and reserved in CSS');

  const manifest = JSON.parse(
    await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  expect(manifest.display === 'standalone', 'the manifest asks for a standalone window');
  expect(manifest.start_url === '/', 'the manifest has a start_url');
  expect(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'the manifest has icons');

  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  expect(html.includes('rel="manifest"'), 'the page links its manifest');
  expect(html.includes('apple-mobile-web-app-capable'), 'iOS is told it may run standalone');
  expect(html.includes('viewport-fit=cover'), 'the viewport still covers the display');

  const shell = await browser.newContext({ viewport: { width: 874, height: 402 }, hasTouch: true, isMobile: true });
  const sh = await shell.newPage();
  const missing = [];
  sh.on('response', (r) => { if (r.status() >= 400) missing.push(`${r.url()} ${r.status()}`); });
  await sh.goto(base, { waitUntil: 'networkidle' });
  for (const asset of ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) {
    const res = await sh.request.get(base + asset);
    expect(res.ok(), `${asset} is served (${res.status()})`);
  }
  expect(missing.length === 0, `the page loads nothing broken ${JSON.stringify(missing)}`);

  // Landscape on a notched phone in a standalone window carries insets on the
  // sides and along the home bar. env() cannot be emulated, so stand in for it
  // and check the shell still holds.
  await sh.addStyleTag({ content:
    'body { padding-left: 59px !important; padding-right: 59px !important;' +
    ' padding-bottom: 21px !important; }' });
  await sh.evaluate(() => {
    handle('OK'); handle('OK');
    setup.names = ['Ann', 'Bo']; setup.count = 2;
    handle('OK'); handle('OK');
    while (currentScreen() === 'draft') handle('OK');
    handle('OK'); handle('OK');
    while (S.q.revealed < 4) handle('OK');
  });

  const shellState = await sh.evaluate(() => {
    const scroll = document.querySelector('.screen-scroll');
    const bar = document.querySelector('.hints');
    return {
      hasScroller: !!scroll,
      barBelowContent: bar.getBoundingClientRect().top >= scroll.getBoundingClientRect().bottom - 1,
      documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      barOnScreen: bar.getBoundingClientRect().bottom <= window.innerHeight + 1,
    };
  });
  expect(shellState.hasScroller, 'content sits in its own scrolling region');
  expect(shellState.barBelowContent, 'the control bar sits below the content, never over it');
  expect(!shellState.documentScrolls, 'the page itself never scrolls - only the content region does');
  expect(shellState.barOnScreen, 'the control bar is on screen');

  // And with those insets applied, every option still answers a finger.
  const deadInset = [];
  const count = await sh.evaluate(() => document.querySelectorAll('.opt').length);
  for (let i = 0; i < count; i++) {
    await sh.evaluate(() => { S.q.sel = null; render(); });
    const box = await sh.evaluate((idx) => {
      const r = document.querySelectorAll('.opt')[idx].getBoundingClientRect();
      const bar = document.querySelector('.hints').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, clear: r.bottom <= bar.top + 1 };
    }, i);
    if (!box.clear) { await sh.locator('.opt').nth(i).tap(); }
    else { await sh.touchscreen.tap(box.x, box.y); }
    if (await sh.evaluate(() => S.q.sel) !== i) deadInset.push(`option ${i}`);
  }
  expect(deadInset.length === 0,
    `landscape with notch insets: every option answers a finger ${JSON.stringify(deadInset)}`);
  await shell.close();
}

// ------------------------------------------------------------ television fit

// A television has no scrollbar and the body does not scroll, so anything past
// the bottom edge is lost - including the hint bar, the only thing telling the
// host what the buttons do. Every screen must fit, at worst-case content.
console.log('\ntelevision fit');

for (const [w, h] of [[1920, 1080], [1280, 720]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const tv = await ctx.newPage();
  await tv.goto(base, { waitUntil: 'networkidle' });

  const probe = await tv.evaluate(() => {
    const out = [];
    const measure = (label) => {
      const d = document.documentElement;
      const hints = document.querySelector('.hints');
      out.push({
        label,
        over: d.scrollHeight - d.clientHeight,
        hintsBottom: hints ? Math.round(hints.getBoundingClientRect().bottom) : 0,
        hasOptions: document.querySelectorAll('.opt').length,
        stealOptions: S && S.steal ? S.steal.alive.length : null,
      });
    };

    handle('OK'); handle('OK');
    setup.names = ['Alexandra', 'Bartholomew', 'Cassiopeia', 'Demetrius'];
    setup.count = 4;
    for (let i = 0; i < 4; i++) handle('OK');
    measure('draft');
    while (currentScreen() === 'draft') handle('OK');
    measure('section intro');
    handle('OK');
    measure('wager');
    handle('OK');

    // Substitute worst-case text so the result is not luck of the draw.
    S.q.text = 'Which of these long-winded and thoroughly padded questions is ' +
      'the one that wraps onto three separate lines on a television screen?';
    S.q.options = [0, 1, 2, 3].map((n) => 'A thoroughly padded answer option ' + n);
    S.q.correctIdx = 0;
    render();
    measure('question, nothing revealed');
    for (let i = 0; i < 4; i++) handle('OK');
    measure('question, all revealed');

    // Lock early: the judge screen then carries its longest detail line and
    // opens the whole board, which is the densest it ever gets.
    S.q.revealed = 2; S.q.sel = 1; render();
    handle('OK');
    measure('judge, early lock, answer withheld');
    handle('OK');
    measure('steal');
    const hit = S.steal.alive.indexOf(S.q.correctIdx);
    while (S.steal.cursor !== hit) handle('RIGHT');
    handle('OK');
    measure('judge, steal resolved');
    return out;
  });

  for (const r of probe) {
    expect(r.over === 0 && r.hintsBottom <= h,
      `${w}x${h} ${r.label}: fits (overflow ${r.over}px, hint bar ends at ${r.hintsBottom})`);
  }
  // Guards the var-hoisting class of bug: a judge screen that silently drops
  // its question block would "fit" perfectly.
  const judges = probe.filter((r) => r.label.startsWith('judge'));
  expect(judges.every((r) => r.hasOptions === 4),
    `${w}x${h}: the judge screens still show all four options`);
  const steal = probe.find((r) => r.label === 'steal');
  expect(steal.stealOptions === 3,
    `${w}x${h}: the steal offers three options after an early lock ` +
    `(got ${steal.stealOptions})`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failing` : '\nall green');
process.exit(failures.length ? 1 : 0);
