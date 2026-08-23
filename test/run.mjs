// Plays many full games against the real question bank and asserts the rules.
import { readFileSync } from 'node:fs';
import { playGame, makeGame } from './play.mjs';

const bank = JSON.parse(readFileSync(new URL('../public/questions.json', import.meta.url), 'utf8'));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// Deterministic RNG so a failure is reproducible from its seed.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('bank: ' + bank.questions.length + ' questions, ' + bank.categories.length + ' categories');

console.log('\nfull games');
const totals = { steals: 0, sweeps: 0, earlyLocks: 0, questions: 0 };
for (const p of [0.0, 0.25, 0.5, 0.75, 1.0]) {
  for (let seed = 1; seed <= 8; seed++) {
    check(`pCorrect=${p} seed=${seed}`, () => {
      const r = playGame(bank, { pCorrect: p, rng: mulberry(seed * 7919 + p * 1000) });
      totals.steals += r.steals;
      totals.sweeps += r.sweeps;
      totals.earlyLocks += r.earlyLocks;
      totals.questions += r.questions;
      const s = r.g.S;
      if (s.players.length !== 4) throw new Error('lost a player');
      for (const pl of s.players) {
        if (!Number.isFinite(pl.score)) throw new Error('non-numeric score');
        if (pl.ledger.length) throw new Error('ledger not emptied: ' + pl.name);
      }
      const board = r.g.ctx.standings();
      if (board[0].score < board[board.length - 1].score) throw new Error('standings unsorted');
    });
  }
}
console.log(`  (${totals.questions} questions asked, ${totals.steals} steals, ` +
            `${totals.sweeps} sweeps, ${totals.earlyLocks} early locks)`);

console.log('\nrules');

check('ledger values map to the documented difficulty', () => {
  const g = makeGame(bank);
  const map = g.ctx.DIFFICULTY_FOR_VALUE;
  const want = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2 };
  for (const k in want) if (map[k] !== want[k]) throw new Error('value ' + k);
});

check('final wager cap lets the trailer catch the leader', () => {
  const g = makeGame(bank);
  g.ctx.S = { players: [{ score: 100 }, { score: 4 }] };
  const cap = g.ctx.finalCapFor(g.ctx.S.players[1]);
  if (4 + cap <= 100) throw new Error('trailer cannot catch up: cap ' + cap);
  if (g.ctx.finalCapFor(g.ctx.S.players[0]) !== 15) throw new Error('leader cap should floor at 15');
});

check('speed clock lengthens for trailing players, capped', () => {
  const g = makeGame(bank);
  g.ctx.S = { players: [{ score: 100 }, { score: 100 }] };
  const base = g.ctx.speedClockFor({ score: 100 });
  const behind = g.ctx.speedClockFor({ score: 60 });
  const miles = g.ctx.speedClockFor({ score: -500 });
  if (behind <= base) throw new Error('no comeback bonus');
  if (miles - base > g.ctx.TUNING.speedBonusCap) throw new Error('bonus uncapped');
});

check('steal pays half the burned value, rounded up', () => {
  const g = makeGame(bank);
  for (const [value, want] of [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3]]) {
    if (Math.ceil(value / 2) !== want) throw new Error('value ' + value);
  }
});

check('free-answer filter drops option-dependent questions', () => {
  const g = makeGame(bank);
  const bad = g.ctx.bank.questions.filter((q) => q.speakable &&
    /which of the following|of these|all of the above/i.test(q.q));
  if (bad.length) throw new Error(bad.length + ' leaked, e.g. ' + bad[0].q);
  const speakable = g.ctx.bank.questions.filter((q) => q.speakable);
  if (speakable.length < 300) throw new Error('only ' + speakable.length + ' speakable questions');
});

check('every draftable category can supply all three difficulties', () => {
  const g = makeGame(bank);
  g.ctx.S = { usedQuestions: [] };
  const cats = g.ctx.draftableCategories(4);
  if (cats.length < 9) throw new Error('only ' + cats.length + ' categories with 4+ per tier');
  for (const id of cats) {
    for (let d = 0; d < 3; d++) {
      if (!g.ctx.bank.byCat[id][d].length) throw new Error('cat ' + id + ' tier ' + d);
    }
  }
});

check('undo walks a game back to the start', () => {
  const g = makeGame(bank);
  g.press('OK'); g.press('OK');
  const done = [5, 4];
  for (let i = 0; i < 4; i++) {
    while (g.ctx.setup.row !== done[0]) g.press('DOWN');
    while (g.ctx.setup.col !== done[1]) g.press('RIGHT');
    g.press('OK');
  }
  if (g.screen() !== 'draft') throw new Error('expected draft, got ' + g.screen());
  for (let i = 0; i < 4; i++) g.press('OK');       // four vetoes
  g.press('OK');                                    // section intro
  g.press('OK');                                    // wager
  const before = JSON.stringify(g.S.players.map((p) => p.ledger));
  for (let i = 0; i < 3; i++) g.press('OK');        // reveal A, B, C
  g.press('RIGHT'); g.press('OK');                  // lock
  if (g.screen() !== 'judge') throw new Error('expected judge, got ' + g.screen());
  let guard = 0;
  while (g.screen() !== 'wager' && guard++ < 40) g.press('BACK');
  while (g.screen() !== 'draft' && guard++ < 80) g.press('BACK');
  if (g.screen() !== 'draft') throw new Error('undo did not reach the draft');
});

check('a misjudged answer can be taken back', () => {
  const g = makeGame(bank);
  g.press('OK'); g.press('OK');
  for (let i = 0; i < 4; i++) {
    while (g.ctx.setup.row !== 5) g.press('DOWN');
    while (g.ctx.setup.col !== 4) g.press('RIGHT');
    g.press('OK');
  }
  for (let i = 0; i < 4; i++) g.press('OK');
  g.press('OK'); g.press('OK');
  const scoresBefore = g.S.players.map((p) => p.score);
  for (let i = 0; i < 4; i++) g.press('OK');
  const wrong = (g.S.q.correctIdx + 1) % 4;
  while (g.S.q.sel !== wrong) g.press('RIGHT');
  g.press('OK');
  if (g.S.result.kind !== 'wrong') throw new Error('expected a miss');
  g.press('BACK');
  if (g.screen() !== 'question') throw new Error('back did not return to the question');
  while (g.S.q.sel !== g.S.q.correctIdx) g.press('RIGHT');
  g.press('OK');
  if (g.S.result.kind !== 'correct') throw new Error('re-answer did not register');
  const gained = g.S.players.map((p, i) => p.score - scoresBefore[i]).reduce((a, b) => a + b, 0);
  if (gained <= 0) throw new Error('no points after correcting the misjudge');
});

console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
