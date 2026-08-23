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

console.log('\nplayer counts');
for (const names of [['Ann', 'Bo'], ['Ann', 'Bo', 'Cy']]) {
  for (let seed = 1; seed <= 4; seed++) {
    check(`${names.length} players seed=${seed}`, () => {
      const r = playGame(bank, { names, pCorrect: 0.5, rng: mulberry(seed * 104729) });
      const s = r.g.S;
      if (s.players.length !== names.length) throw new Error('wrong player count');
      for (const p of s.players) if (p.ledger.length) throw new Error('ledger not emptied');
      // With two players the stealer is always the other player, never the misser.
      if (names.length === 2 && r.steals === 0 && r.g.S.usedQuestions.length > 10) {
        throw new Error('two-player game never offered a steal');
      }
    });
  }
}

console.log('\nrules');

check('difficulty is a property of the section, not the wager', () => {
  const g = makeGame(bank);
  const [one, two] = g.ctx.SECTIONS;
  if (one.difficulty !== 0) throw new Error('section 1 should be easy');
  if (two.difficulty !== 2) throw new Error('section 2 should be hard');
  if (g.ctx.SPEED_DIFFICULTY !== 1) throw new Error('the speed round should be medium');
  if (g.ctx.DIFFICULTY_FOR_VALUE) throw new Error('the wager-to-difficulty map still exists');
});

check('every section 1 question is easy and every section 2 question is hard', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const r = playGame(bank, { pCorrect: 0.5, rng: mulberry(seed * 31337) });
    const bad = r.asked.filter((q) => q.difficulty !== [0, 2][q.section]);
    if (bad.length) {
      throw new Error(`${bad.length} of ${r.asked.length} off-tier, e.g. section ` +
        `${bad[0].section} drew tier ${bad[0].difficulty}`);
    }
    if (!r.asked.some((q) => q.section === 0) || !r.asked.some((q) => q.section === 1)) {
      throw new Error('a section drew no questions at all');
    }
  }
});

check('the speed round runs between the two sections', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const r = playGame(bank, { pCorrect: 0.5, rng: mulberry(seed * 7717) });
    if (r.speedAtSection !== 0) {
      throw new Error('speed round began during section ' + r.speedAtSection);
    }
    // Section 2 questions must all come after the speed round in play order.
    const firstSectionTwo = r.asked.findIndex((q) => q.section === 1);
    const lastSectionOne = r.asked.map((q) => q.section).lastIndexOf(0);
    if (firstSectionTwo < lastSectionOne) throw new Error('the sections interleaved');
  }
});

check('steal values are flat per section', () => {
  const g = makeGame(bank);
  const [one, two] = g.ctx.SECTIONS;
  if (one.stealValue !== 1) throw new Error('a section 1 steal should pay 1');
  if (two.stealValue !== 2) throw new Error('a section 2 steal should pay 2');
});

check('the answer stays hidden until the steal is settled', () => {
  const shows = () => /class="opt[^"]*\bcorrect\b/.test(g.html());
  const g = makeGame(bank);
  g.press('OK'); g.press('LEFT'); g.press('OK');    // three players
  for (let i = 0; i < 3; i++) g.press('OK');        // default names
  while (g.screen() === 'draft') g.press('OK');
  g.press('OK');                                    // section intro
  g.press('OK');                                    // wager
  for (let i = 0; i < 4; i++) g.press('OK');        // reveal all four

  const wrong = (g.S.q.correctIdx + 1) % 4;
  while (g.S.q.sel !== wrong) g.press('RIGHT');
  g.press('OK');
  if (g.S.result.kind !== 'wrong') throw new Error('expected a miss');
  if (shows()) throw new Error('the answer was shown on the miss');

  g.press('OK');
  if (g.screen() !== 'steal') throw new Error('no steal was offered');
  if (shows()) throw new Error('the answer was shown during the steal');

  const stealer = g.S.steal.playerIdx;
  const before = g.S.players[stealer].score;
  const hit = g.S.steal.alive.indexOf(g.S.q.correctIdx);
  while (g.S.steal.cursor !== hit) g.press('RIGHT');
  g.press('OK');
  if (g.S.players[stealer].score - before !== 1) throw new Error('a section 1 steal should pay 1');
  if (!shows()) throw new Error('the answer stayed hidden after the steal resolved');
});

check('passing on a steal still shows the answer', () => {
  const g = makeGame(bank);
  g.press('OK'); g.press('LEFT'); g.press('OK');
  for (let i = 0; i < 3; i++) g.press('OK');
  while (g.screen() === 'draft') g.press('OK');
  g.press('OK'); g.press('OK');
  for (let i = 0; i < 4; i++) g.press('OK');
  const wrong = (g.S.q.correctIdx + 1) % 4;
  while (g.S.q.sel !== wrong) g.press('RIGHT');
  g.press('OK');
  g.press('OK');
  g.press('DOWN');                                  // pass
  if (!/class="opt[^"]*\bcorrect\b/.test(g.html())) {
    throw new Error('passing left the answer hidden');
  }
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

check('free-answer filter drops option-dependent questions', () => {
  const g = makeGame(bank);
  const bad = g.ctx.bank.questions.filter((q) => q.speakable &&
    /which of the following|of these|all of the above/i.test(q.q));
  if (bad.length) throw new Error(bad.length + ' leaked, e.g. ' + bad[0].q);
  const speakable = g.ctx.bank.questions.filter((q) => q.speakable);
  if (speakable.length < 300) throw new Error('only ' + speakable.length + ' speakable questions');
});

check('the bank can supply a whole section from a single tier', () => {
  // Each section now draws one difficulty throughout, so demand concentrates.
  // Section 2 with four players is the worst case: a nine-category draft pool
  // where each surviving category must yield four hard questions.
  const g = makeGame(bank);
  const players = 4;
  const cats = g.ctx.draftableCategories(players);
  const poolNeeded = 5 + players;
  if (cats.length < poolNeeded) {
    throw new Error(`only ${cats.length} categories carry ${players}+ per tier, ` +
      `need ${poolNeeded} for the section 2 draft`);
  }
  for (const id of cats) {
    for (let d = 0; d < 3; d++) {
      if (g.ctx.bank.byCat[id][d].length < players) {
        throw new Error(`category ${id} has only ${g.ctx.bank.byCat[id][d].length} at tier ${d}`);
      }
    }
  }
});

check('an unnamed player falls back to Player N', () => {
  const g = makeGame(bank);
  g.press('OK');
  g.press('LEFT'); g.press('LEFT');                 // two players
  g.press('OK');
  g.ctx.setup.names[0] = '  Ada  ';                 // the field keeps raw text
  g.press('OK');
  g.press('OK');                                    // second player left blank
  if (g.S.players[0].name !== 'Ada') throw new Error('name not trimmed: ' + g.S.players[0].name);
  if (g.S.players[1].name !== 'Player 2') throw new Error('blank name not defaulted');
});

check('Back steps through the name screens and out to the count', () => {
  const g = makeGame(bank);
  g.press('OK'); g.press('OK');
  g.ctx.setup.names[0] = 'Ada';
  g.press('OK');
  if (g.ctx.setup.playerIdx !== 1) throw new Error('did not advance to player 2');
  g.press('BACK');
  if (g.ctx.setup.playerIdx !== 0) throw new Error('Back did not return to player 1');
  if (g.ctx.setup.names[0] !== 'Ada') throw new Error('Back lost the typed name');
  g.press('BACK');
  if (g.screen() !== 'setupCount') throw new Error('Back did not reach the count screen');
});

check('a bank too thin to veto still yields a playable section', () => {
  // Two categories total: not enough to hand every player a veto.
  const keep = new Set(bank.categories.slice(0, 2).map((c) => c.id));
  const thin = {
    categories: bank.categories.filter((c) => keep.has(c.id)),
    questions: bank.questions.filter((q) => keep.has(q.c)),
  };
  const r = playGame(thin, { pCorrect: 0.5, rng: mulberry(42) });
  for (const p of r.g.S.players) {
    if (p.ledger.length) throw new Error('ledger not emptied on a thin bank');
  }
  if (!r.g.S.categories.length) throw new Error('every category was vetoed away');
});

check('undo walks a game back to the start', () => {
  const g = makeGame(bank);
  g.press('OK'); g.press('OK');
  for (let i = 0; i < 4; i++) g.press('OK');       // accept the default names
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
  for (let i = 0; i < 4; i++) g.press('OK');       // accept the default names
  for (let i = 0; i < 4; i++) g.press('OK');       // four vetoes
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
