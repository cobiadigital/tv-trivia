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
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
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
  ['small Android', 360, 640],
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
    handle('OK'); handle('OK'); handle('OK'); handle('OK');
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
    return {
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
  expect(m.overflowX === 0, `${label}: no horizontal overflow (${m.overflowX}px)`);
  expect(!m.clipped, `${label}: overflowing content scrolls instead of being clipped`);
  expect(m.hintsOnScreen, `${label}: the control bar stays on screen`);
  expect(m.questionSize >= 16 && m.questionSize <= 40,
    `${label}: question text is legible but fits (${m.questionSize}px)`);
  expect(m.small.length === 0, `${label}: touch targets clear 32px ${JSON.stringify(m.small)}`);
  expect(perr.length === 0, `${label}: no page errors`);
  await ctx.close();
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
