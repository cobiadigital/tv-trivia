// Headless driver for public/app.js. Stubs just enough DOM to run the real
// game module, then plays complete games and asserts the rules hold.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  // Drop the boot tail: listeners and the network load.
  .replace(/document\.addEventListener[\s\S]*$/, '');

export function makeGame(bankJson) {
  let html = '';
  const node = { innerHTML: '', textContent: '', className: '' };
  const ctx = vm.createContext({
    console,
    Date,
    Math,
    JSON,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => Promise.reject(new Error('no network in tests')),
    document: {
      getElementById: () => ({ set innerHTML(v) { html = v; }, get innerHTML() { return html; } }),
      querySelector: () => node,
      addEventListener: () => {},
    },
  });
  vm.runInContext(APP, ctx, { filename: 'app.js' });
  ctx.bank = ctx.indexBank(bankJson);
  return {
    ctx,
    html: () => html,
    press: (a) => ctx.handle(a),
    get S() { return ctx.S; },
    screen: () => ctx.currentScreen(),
  };
}

const LETTERS = ['A', 'B', 'C', 'D'];

// Plays one whole game. `pCorrect` drives the bot's accuracy so that the same
// harness exercises sweeps, steals, and blowouts.
export function playGame(bankJson, opts = {}) {
  const { pCorrect = 0.5, names = ['Ann', 'Bo', 'Cy', 'Dee'], rng = Math.random } = opts;
  const g = makeGame(bankJson);
  const log = [];
  const seen = new Set();

  const guard = (n) => { if (log.length > n) throw new Error('runaway: ' + log.join(',')); };

  function press(a) {
    log.push(g.screen() + ':' + a);
    guard(60000);
    g.press(a);
    // Rendering every frame is how a real session finds template bugs.
    const out = g.html();
    if (typeof out !== 'string' || !out.length) {
      throw new Error('empty render on ' + g.screen());
    }
  }

  // Attract -> setup -> names
  press('OK');
  press('OK');                       // accept 4 players
  for (let i = 0; i < names.length; i++) {
    for (const ch of names[i].toUpperCase()) {
      const r = ctxFindKey(ch);
      moveTo(g, press, r[0], r[1]);
      press('OK');
    }
    const d = ctxFindKey('DONE');
    moveTo(g, press, d[0], d[1]);
    press('OK');
  }

  let steals = 0, sweeps = 0, earlyLocks = 0, questions = 0;

  for (let step = 0; step < 40000; step++) {
    const s = g.screen();
    if (s === 'scoreboard') break;

    switch (s) {
      case 'draft': press('OK'); break;
      case 'sectionIntro': press('OK'); break;
      case 'wager': {
        const p = g.S.players[g.S.order[g.S.turn]];
        const n = Math.floor(rng() * p.ledger.length);
        for (let i = 0; i < n; i++) press('RIGHT');
        press('OK');
        break;
      }
      case 'question': {
        const q = g.S.q;
        if (seen.has(q.id)) throw new Error('repeated question id ' + q.id);
        seen.add(q.id);
        questions++;
        const want = rng() < pCorrect
          ? q.correctIdx
          : (q.correctIdx + 1 + Math.floor(rng() * 3)) % 4;
        // Reveal at least enough options to reach the target.
        const reveals = Math.max(want + 1, 1 + Math.floor(rng() * 4));
        while (g.S.q.revealed < reveals) press('OK');
        while (g.S.q.sel !== want) press('RIGHT');
        if (g.S.q.revealed < 4) earlyLocks++;
        press('OK');
        break;
      }
      case 'judge':
        if (g.S.result.kind === 'sweep') sweeps++;
        press('OK');
        break;
      case 'steal': {
        steals++;
        const st = g.S.steal;
        const hit = st.alive.indexOf(g.S.q.correctIdx);
        if (hit >= 0 && rng() < pCorrect) {
          while (g.S.steal.cursor !== hit) press('RIGHT');
          press('OK');
        } else if (rng() < 0.5) {
          press('DOWN');
        } else {
          press('OK');
        }
        break;
      }
      case 'speedIntro': press('OK'); break;
      case 'speedPlay': {
        const sp = g.S.speed;
        if (sp.asked >= 6) {           // cut the clock short deterministically
          sp.endsAt = Date.now() - 1;
          g.ctx.tickTimer();
          break;
        }
        if (!sp.revealed) press('OK');
        else press(rng() < pCorrect ? 'RIGHT' : 'LEFT');
        break;
      }
      case 'speedResult': press('OK'); break;
      case 'finalIntro': press('OK'); break;
      case 'finalWager': {
        const f = g.S.final;
        const n = Math.floor(rng() * 4);
        for (let i = 0; i < n; i++) press('UP');
        press('OK');
        break;
      }
      case 'finalQuestion': press('OK'); break;
      case 'finalReveal': press('OK'); break;
      case 'finalJudge': press(rng() < pCorrect ? 'RIGHT' : 'LEFT'); break;
      case 'sudden':
        if (!g.S.sudden.revealed) press('OK');
        else press(rng() < 0.7 ? 'OK' : 'DOWN');
        break;
      default:
        throw new Error('stuck on screen: ' + s);
    }
  }

  if (g.screen() !== 'scoreboard') throw new Error('never reached scoreboard');
  return { g, steals, sweeps, earlyLocks, questions, log };
}

const KEYS = [
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  ['H', 'I', 'J', 'K', 'L', 'M', 'N'],
  ['O', 'P', 'Q', 'R', 'S', 'T', 'U'],
  ['V', 'W', 'X', 'Y', 'Z', "'", 'SPACE'],
  ['0', '1', '2', '3', '4', '5', '6'],
  ['7', '8', '9', 'DEL', 'DONE'],
];

function ctxFindKey(ch) {
  for (let r = 0; r < KEYS.length; r++) {
    const c = KEYS[r].indexOf(ch);
    if (c >= 0) return [r, c];
  }
  throw new Error('no key for ' + ch);
}

function moveTo(g, press, row, col) {
  let guard = 0;
  while (g.ctx.setup.row !== row) { press('DOWN'); if (guard++ > 20) throw new Error('row nav'); }
  guard = 0;
  while (g.ctx.setup.col !== col) { press('RIGHT'); if (guard++ > 20) throw new Error('col nav'); }
}
