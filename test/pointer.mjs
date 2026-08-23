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

for (const ch of 'JO') await page.locator(`.key:text-is("${ch}")`).click();
expect(await state(() => setup.names[0]) === 'JO', 'keyboard keys type on one tap');
await page.locator('.key:text-is("DEL")').click();
expect(await state(() => setup.names[0]) === 'J', 'the DEL key deletes a character');
await page.locator('.key:text-is("DONE")').click();
await page.locator('.key:text-is("DONE")').click();
expect(await screen() === 'draft', 'setup completes by pointer');

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

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failing` : '\nall green');
process.exit(failures.length ? 1 : 0);
