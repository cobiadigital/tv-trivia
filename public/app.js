'use strict';

/* Remote Trivia. One remote, one screen, no pairing.
   Everything below is deliberately ES2017-level: no optional chaining, no
   nullish coalescing, no structuredClone. Old TV browser engines choke on
   those and a syntax error here means a black screen on the television. */

// ------------------------------------------------------------------ tuning

var TUNING = {
  speedBaseSeconds: 45,        // open question in the design doc: try 45 vs 60
  speedBonusPer10Behind: 5,
  speedBonusCap: 20,
  finalThinkSeconds: 30,
  earlyLockBonus: 1,
  sweepBonus: 3,
  maxNameLength: 10
};

var SECTIONS = [
  { number: 1, ledger: [1, 2, 3, 4] },
  { number: 2, ledger: [2, 3, 4, 5, 6] }
];

// Wagered value picks the difficulty tier. 0 = easy, 1 = medium, 2 = hard.
var DIFFICULTY_FOR_VALUE = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2 };

var DIFFICULTY_NAMES = ['Easy', 'Medium', 'Hard'];

// OpenTDB questions are written to be read with four options in front of you.
// These read as nonsense without them, so they are barred from the free-answer
// rounds (speed round and final).
// Two patterns, because the case rules differ: the stock phrases should match
// however they are capitalised, but a bare "not" is only a giveaway when the
// question shouts it.
var UNSPEAKABLE = /which of (the following|these)|of the following|of these|all of the above|none of the above|which (one )?is not\b/i;
var UNSPEAKABLE_CASED = /\bNOT\b/;

// ------------------------------------------------------------------ helpers

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function shuffle(a) {
  var out = a.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

function shortCategory(name) {
  return name.replace(/^Entertainment: /, '').replace(/^Science: /, '');
}

function plural(n, one, many) { return n === 1 ? one : many; }

// ------------------------------------------------------------------- bank

var bank = null;   // { categories, questions, byCat, catName }

function indexBank(raw) {
  var byCat = {};
  var catName = {};
  var i, c;

  for (i = 0; i < raw.categories.length; i++) {
    c = raw.categories[i];
    catName[c.id] = shortCategory(c.name);
  }

  for (i = 0; i < raw.questions.length; i++) {
    var q = raw.questions[i];
    q.id = i;
    // Free-answer rounds need a question that stands on its own and an answer
    // short enough to judge by ear.
      q.speakable = !UNSPEAKABLE.test(q.q) && !UNSPEAKABLE_CASED.test(q.q) &&
      q.a.split(/\s+/).length <= 3;
    if (!byCat[q.c]) byCat[q.c] = [[], [], []];
    byCat[q.c][q.d].push(q);
  }

  return {
    categories: raw.categories,
    questions: raw.questions,
    byCat: byCat,
    catName: catName
  };
}

// A category is only worth drafting if it can supply every difficulty tier;
// otherwise a 6-wager silently degrades into an easy question.
function draftableCategories(minPerTier) {
  var out = [];
  for (var id in bank.byCat) {
    var tiers = bank.byCat[id];
    if (tiers[0].length >= minPerTier &&
        tiers[1].length >= minPerTier &&
        tiers[2].length >= minPerTier) {
      out.push(Number(id));
    }
  }
  return out;
}

// Pull an unused question, relaxing difficulty and then category rather than
// ever failing to produce one.
function drawQuestion(categoryId, difficulty, opts) {
  opts = opts || {};
  var used = S.usedQuestions;
  var wantSpeakable = !!opts.speakable;

  function pick(list) {
    var pool = [];
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (used.indexOf(q.id) !== -1) continue;
      if (wantSpeakable && !q.speakable) continue;
      pool.push(q);
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  var tiers = bank.byCat[categoryId];
  var found = null;

  if (tiers) {
    found = pick(tiers[difficulty]);
    // Nearest tiers first, so a hard request degrades to medium before easy.
    if (!found) {
      var order = [difficulty - 1, difficulty + 1, difficulty - 2, difficulty + 2];
      for (var k = 0; k < order.length && !found; k++) {
        if (order[k] >= 0 && order[k] <= 2) found = pick(tiers[order[k]]);
      }
    }
  }

  if (!found) {
    // Last resort: anything unused anywhere at the right difficulty.
    var everything = [];
    for (var id in bank.byCat) {
      everything = everything.concat(bank.byCat[id][difficulty]);
    }
    found = pick(everything);
  }
  if (!found) found = pick(bank.questions);

  // Rather than crash on an exhausted bank, allow a repeat. Only reachable in
  // a session long enough to burn through every eligible question.
  if (!found) {
    var fallback = wantSpeakable
      ? bank.questions.filter(function (q) { return q.speakable; })
      : bank.questions;
    found = fallback[Math.floor(Math.random() * fallback.length)];
  }

  if (used.indexOf(found.id) === -1) used.push(found.id);
  return found;
}

function buildQuestionState(q, categoryId, value, ownerIdx) {
  var options = shuffle([q.a].concat(q.w));
  return {
    id: q.id,
    text: q.q,
    correct: q.a,
    options: options,
    correctIdx: options.indexOf(q.a),
    categoryId: categoryId,
    difficulty: q.d,
    value: value,
    ownerIdx: ownerIdx,
    revealed: 0,
    sel: null,
    lockedIdx: null,
    earlyLock: false
  };
}

// ------------------------------------------------------------------- state

var S = null;         // the whole game
var past = [];        // undo stack of whole-game snapshots
var MAX_UNDO = 60;

function snapshot() {
  past.push(clone(S));
  if (past.length > MAX_UNDO) past.shift();
}

function undo() {
  if (!past.length) return false;
  stopTimer();
  S = past.pop();
  render();
  return true;
}

function newGame(names) {
  var players = names.map(function (n, i) {
    return {
      name: n || ('Player ' + (i + 1)),
      score: 0,
      ledger: [],
      spent: [],
      qIndex: 0,
      missedThisSection: false,
      speedScore: 0
    };
  });

  S = {
    screen: 'draft',
    players: players,
    sectionIndex: 0,
    order: players.map(function (_, i) { return i; }),
    turn: 0,
    categories: [],
    usedQuestions: [],
    draft: null,
    q: null,
    result: null,
    steal: null,
    speed: null,
    final: null,
    sudden: null
  };

  startDraft();
}

function section() { return SECTIONS[S.sectionIndex]; }
function currentPlayer() { return S.players[S.order[S.turn]]; }
function currentPlayerIdx() { return S.order[S.turn]; }

function leaderScore() {
  var best = -Infinity;
  for (var i = 0; i < S.players.length; i++) {
    if (S.players[i].score > best) best = S.players[i].score;
  }
  return best;
}

// ------------------------------------------------------------- category draft

function startDraft() {
  var perPlayer = section().ledger.length;
  var poolSize = perPlayer + S.players.length;

  var eligible = draftableCategories(Math.max(2, S.players.length));
  if (eligible.length < poolSize) eligible = draftableCategories(1);
  if (eligible.length < poolSize) {
    eligible = Object.keys(bank.byCat).map(Number);
  }

  var pool = shuffle(eligible).slice(0, poolSize);

  S.draft = {
    pool: pool,
    // Everyone vetoes one, unless the bank is too thin to survive that many.
    vetoes: Math.max(0, Math.min(S.players.length, pool.length - perPlayer)),
    vetoed: [],
    cursor: 0,
    vetoerTurn: 0
  };
  if (!S.draft.vetoes) {
    S.categories = pool;
    beginSection();
    return;
  }
  S.screen = 'draft';
}

function applyVeto() {
  var d = S.draft;
  var id = d.pool[d.cursor];
  if (d.vetoed.indexOf(id) !== -1) return;

  d.vetoed.push(id);
  d.vetoerTurn++;

  if (d.vetoerTurn >= d.vetoes) {
    S.categories = d.pool.filter(function (id) {
      return d.vetoed.indexOf(id) === -1;
    });
    beginSection();
    return;
  }

  // Park the cursor on the next category that is still alive.
  for (var i = 0; i < d.pool.length; i++) {
    var probe = (d.cursor + i) % d.pool.length;
    if (d.vetoed.indexOf(d.pool[probe]) === -1) { d.cursor = probe; break; }
  }
}

// ------------------------------------------------------------------- section

function beginSection() {
  var sec = section();
  for (var i = 0; i < S.players.length; i++) {
    var p = S.players[i];
    p.ledger = sec.ledger.slice();
    p.spent = [];
    p.qIndex = 0;
    p.missedThisSection = false;
    p.sweepAwarded = false;
  }
  S.turn = 0;
  S.screen = 'sectionIntro';
}

// Move to the next player who still has ledger values left. Returns false when
// every ledger is empty, which is what ends the section.
function advanceTurn() {
  var n = S.order.length;
  for (var i = 1; i <= n; i++) {
    var t = (S.turn + i) % n;
    if (S.players[S.order[t]].ledger.length) { S.turn = t; return true; }
  }
  return false;
}

function afterQuestionResolved() {
  var p = currentPlayer();

  // A correct answer keeps the spotlight, as long as the ledger holds more.
  if (S.result && S.result.rollAgain && p.ledger.length) {
    S.screen = 'wager';
    S.wagerCursor = 0;
    return;
  }

  if (!p.ledger.length && !p.missedThisSection && !p.sweepAwarded) {
    p.sweepAwarded = true;
    p.score += TUNING.sweepBonus;
    S.result = {
      kind: 'sweep',
      headline: p.name + ' swept the ledger',
      detail: '+' + TUNING.sweepBonus + ' bonus for clearing every value without a miss.',
      good: true,
      rollAgain: false
    };
    S.screen = 'judge';
    S.sweepShown = true;
    return;
  }

  S.sweepShown = false;

  if (!advanceTurn()) {
    endSection();
    return;
  }
  S.screen = 'wager';
  S.wagerCursor = 0;
}

function endSection() {
  if (S.sectionIndex === 0) {
    S.sectionIndex = 1;
    S.order = S.order.slice().reverse();   // going last is a small edge
    startDraft();
  } else {
    startSpeedRound();
  }
}

// -------------------------------------------------------------- wager & judge

function beginQuestion(value) {
  var p = currentPlayer();
  var idx = p.ledger.indexOf(value);
  if (idx === -1) return;

  p.ledger.splice(idx, 1);
  p.spent.push(value);

  var categoryId = S.categories[p.qIndex % S.categories.length];
  p.qIndex++;

  var q = drawQuestion(categoryId, DIFFICULTY_FOR_VALUE[value], {});
  S.q = buildQuestionState(q, categoryId, value, currentPlayerIdx());
  S.steal = null;
  S.screen = 'question';
}

function lockAnswer(idx) {
  var q = S.q;
  q.lockedIdx = idx;
  q.earlyLock = q.revealed < 4;

  var p = S.players[q.ownerIdx];

  if (idx === q.correctIdx) {
    var gained = q.value + (q.earlyLock ? TUNING.earlyLockBonus : 0);
    p.score += gained;
    S.result = {
      kind: 'correct',
      headline: 'Correct',
      detail: p.name + ' banks ' + q.value +
        (q.earlyLock ? ' +' + TUNING.earlyLockBonus + ' for locking early' : '') +
        '  =  +' + gained,
      good: true,
      rollAgain: true
    };
    S.screen = 'judge';
    return;
  }

  p.missedThisSection = true;
  S.result = {
    kind: 'wrong',
    headline: 'Wrong',
    detail: p.name + ' burns the ' + q.value + '.',
    good: false,
    rollAgain: false
  };
  S.screen = 'judge';
}

// The next player in turn order gets one shot at the same question.
function offerSteal() {
  var q = S.q;
  var alive = [];
  for (var i = 0; i < q.revealed; i++) {
    if (i !== q.lockedIdx) alive.push(i);
  }
  if (!alive.length) { afterQuestionResolved(); return; }

  var stealerTurn = (S.turn + 1) % S.order.length;
  var stealerIdx = S.order[stealerTurn];
  if (stealerIdx === q.ownerIdx) { afterQuestionResolved(); return; }

  S.steal = { playerIdx: stealerIdx, alive: alive, cursor: 0 };
  S.screen = 'steal';
}

function resolveSteal(optionIdx) {
  var q = S.q;
  var p = S.players[S.steal.playerIdx];

  if (optionIdx === q.correctIdx) {
    var gained = Math.ceil(q.value / 2);
    p.score += gained;
    S.result = {
      kind: 'steal',
      headline: 'Stolen',
      detail: p.name + ' takes half of ' + q.value + ', rounded up  =  +' + gained,
      good: true,
      rollAgain: false
    };
  } else {
    S.result = {
      kind: 'stealFailed',
      headline: 'Steal failed',
      detail: 'No cost to ' + p.name + '. The ' + q.value + ' stays burned.',
      good: false,
      rollAgain: false
    };
  }
  S.steal.done = true;
  S.screen = 'judge';
}

// -------------------------------------------------------------- speed round

// Trailing players get a longer clock. Invisible enough not to feel like charity.
function speedClockFor(player) {
  var gap = leaderScore() - player.score;
  var bonus = Math.min(TUNING.speedBonusCap,
    Math.floor(Math.max(0, gap) / 10) * TUNING.speedBonusPer10Behind);
  return TUNING.speedBaseSeconds + bonus;
}

function startSpeedRound() {
  for (var i = 0; i < S.players.length; i++) S.players[i].speedScore = 0;
  S.speed = { seat: 0, running: false, q: null, revealed: false, asked: 0, correct: 0 };
  S.screen = 'speedIntro';
}

function speedPlayerIdx() { return S.order[S.speed.seat]; }

function speedNextQuestion() {
  var sp = S.speed;
  var categoryId = S.categories[sp.asked % S.categories.length];
  var q = drawQuestion(categoryId, sp.asked % 2, { speakable: true });
  sp.q = q;
  sp.revealed = false;
}

function startSpeedTurn() {
  var sp = S.speed;
  sp.running = true;
  sp.asked = 0;
  sp.correct = 0;
  sp.secondsLeft = speedClockFor(S.players[speedPlayerIdx()]);
  sp.endsAt = Date.now() + sp.secondsLeft * 1000;
  speedNextQuestion();
  S.screen = 'speedPlay';
  startTimer();
}

function endSpeedTurn() {
  stopTimer();
  var sp = S.speed;
  sp.running = false;
  S.players[speedPlayerIdx()].score += sp.correct;
  S.players[speedPlayerIdx()].speedScore = sp.correct;
  S.screen = 'speedResult';
}

function speedAdvanceSeat() {
  var sp = S.speed;
  sp.seat++;
  if (sp.seat >= S.order.length) {
    startFinal();
    return;
  }
  S.screen = 'speedIntro';
}

// ------------------------------------------------------------------- final

// The dynamic ceiling guarantees whoever is trailing can mathematically catch
// the leader. (The doc's separate floor of 5 is subsumed by the floor of 15.)
function finalCapFor(player) {
  var gap = leaderScore() - player.score;
  return Math.max(15, gap + 1);
}

function startFinal() {
  var draftable = draftableCategories(1);
  var categoryId = draftable[Math.floor(Math.random() * draftable.length)];
  var q = drawQuestion(categoryId, 1, { speakable: true });

  // Lowest scorer declares first, tournament-Jeopardy style. On one shared
  // screen that is the least awkward way to handle wager secrecy.
  var order = S.players.map(function (_, i) { return i; }).sort(function (a, b) {
    return S.players[a].score - S.players[b].score;
  });

  S.final = {
    categoryId: categoryId,
    question: q,
    wagerOrder: order,
    wagerSeat: 0,
    wagerValue: 0,
    wagers: {},
    judgeSeat: 0,
    verdicts: {},
    secondsLeft: TUNING.finalThinkSeconds
  };
  S.screen = 'finalIntro';
}

function commitFinalWager() {
  var f = S.final;
  var idx = f.wagerOrder[f.wagerSeat];
  f.wagers[idx] = f.wagerValue;
  f.wagerSeat++;
  if (f.wagerSeat >= f.wagerOrder.length) {
    f.secondsLeft = TUNING.finalThinkSeconds;
    f.endsAt = Date.now() + f.secondsLeft * 1000;
    S.screen = 'finalQuestion';
    startTimer();
    return;
  }
  f.wagerValue = 0;
}

function commitFinalVerdict(right) {
  var f = S.final;
  var idx = f.wagerOrder[f.judgeSeat];
  var wager = f.wagers[idx];
  f.verdicts[idx] = right;
  S.players[idx].score += right ? wager : -wager;
  f.judgeSeat++;
  if (f.judgeSeat >= f.wagerOrder.length) finishGame();
}

// --------------------------------------------------------------- end of game

function standings() {
  return S.players.map(function (p, i) { return { idx: i, name: p.name, score: p.score }; })
    .sort(function (a, b) { return b.score - a.score; });
}

function tiedLeaders() {
  var board = standings();
  var top = board[0].score;
  return board.filter(function (r) { return r.score === top; }).map(function (r) { return r.idx; });
}

function finishGame() {
  var tied = tiedLeaders();
  if (tied.length > 1) {
    S.sudden = { players: tied, q: null, revealed: false, cursor: 0 };
    suddenNextQuestion();
    S.screen = 'sudden';
  } else {
    S.screen = 'scoreboard';
  }
}

function suddenNextQuestion() {
  var draftable = draftableCategories(1);
  var categoryId = draftable[Math.floor(Math.random() * draftable.length)];
  S.sudden.q = drawQuestion(categoryId, 1, { speakable: true });
  S.sudden.categoryId = categoryId;
  S.sudden.revealed = false;
  S.sudden.cursor = 0;
}

// -------------------------------------------------------------------- timer

var timerHandle = null;

function startTimer() {
  stopTimer();
  timerHandle = setInterval(tickTimer, 200);
}

function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}

function tickTimer() {
  var target = null;
  if (S.screen === 'speedPlay') target = S.speed;
  else if (S.screen === 'finalQuestion') target = S.final;
  if (!target || !target.endsAt) { stopTimer(); return; }

  var left = Math.max(0, Math.ceil((target.endsAt - Date.now()) / 1000));
  if (left === target.secondsLeft) return;
  target.secondsLeft = left;

  if (left === 0) {
    if (S.screen === 'speedPlay') { endSpeedTurn(); render(); return; }
    stopTimer();
    render();
    return;
  }

  // Repaint just the clock; a full re-render mid-question flickers on a TV.
  var node = document.querySelector('.clock');
  if (node) {
    node.textContent = String(left);
    node.className = left <= 5 ? 'clock low' : 'clock';
  } else {
    render();
  }
}

// ------------------------------------------------------------------ render

var KEYS = [
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  ['H', 'I', 'J', 'K', 'L', 'M', 'N'],
  ['O', 'P', 'Q', 'R', 'S', 'T', 'U'],
  ['V', 'W', 'X', 'Y', 'Z', "'", 'SPACE'],
  ['0', '1', '2', '3', '4', '5', '6'],
  ['7', '8', '9', 'DEL', 'DONE']
];

var setup = null;
var loadError = null;

function hintBar(pairs) {
  var html = pairs.map(function (p) {
    return '<span><b>' + esc(p[0]) + '</b> ' + esc(p[1]) + '</span>';
  }).join('');
  return '<div class="hints">' + html + '</div>';
}

function playerStrip(activeIdx, showLedger) {
  var html = '<div class="playerstrip">';
  for (var i = 0; i < S.players.length; i++) {
    var p = S.players[i];
    var ledger = p.ledger.length ? p.ledger.join(' ') : '—';
    html += '<div class="pcard' + (i === activeIdx ? ' up' : '') + '">' +
      '<div class="pname">' + esc(p.name) + '</div>' +
      '<div class="pscore">' + p.score + '</div>' +
      (showLedger ? '<div class="pledger">' + esc(ledger) + '</div>' : '') +
      '</div>';
  }
  return html + '</div>';
}

function statusBar(extra, label) {
  var slots = ['<div class="slot">' +
    (label ? label : 'Section <b>' + section().number + '</b>') + '</div>'];
  if (extra) slots = slots.concat(extra.map(function (t) {
    return '<div class="slot">' + t + '</div>';
  }));
  return '<div class="statusbar">' + slots.join('') + '</div>';
}

function categoryLine(highlightId) {
  if (!S.categories.length) return '';
  var parts = S.categories.map(function (id) {
    var name = esc(bank.catName[id]);
    return id === highlightId ? '<b>' + name + '</b>' : name;
  });
  return '<div class="catlist">' + parts.join(' &nbsp;·&nbsp; ') + '</div>';
}

function optionRows(q, opts) {
  opts = opts || {};
  var letters = ['A', 'B', 'C', 'D'];
  var html = '<div class="options">';

  for (var i = 0; i < q.options.length; i++) {
    var cls = 'opt';
    var text;

    if (i >= q.revealed) {
      cls += ' hidden';
      text = '<span class="text">not revealed</span>';
    } else {
      text = '<span class="text">' + esc(q.options[i]) + '</span>';
    }

    if (opts.selIdx === i) cls += ' sel';
    if (opts.dead && opts.dead.indexOf(i) !== -1) cls += ' dead';
    if (opts.showResult && i < q.revealed) {
      if (i === q.correctIdx) cls += ' correct';
      else if (i === opts.lockedIdx) cls += ' wrong';
    }

    html += '<div class="' + cls + '"><span class="letter">' + letters[i] + '</span>' + text + '</div>';
  }
  return html + '</div>';
}

function render() {
  var el = document.getElementById('screen');
  el.innerHTML = view();
}

function currentScreen() {
  if (S) return S.screen;
  if (loadError) return 'error';
  if (!bank) return 'loading';
  return setup ? setup.screen : 'attract';
}

function view() {
  switch (currentScreen()) {

    // ------------------------------------------------------------- boot

    case 'loading':
      return '<h1>Remote Trivia</h1><div class="note">Loading questions…</div>';

    case 'error':
      return '<h1>Could not load questions</h1>' +
        '<div class="note">' + esc(loadError) + '</div>' +
        hintBar([['OK', 'retry']]);

    case 'attract':
      return '<div class="eyebrow">One remote. One screen.</div>' +
        '<h1>Remote Trivia</h1>' +
        '<div class="note">' + bank.questions.length + ' questions loaded across ' +
        Object.keys(bank.byCat).length + ' categories. ' +
        'Whoever answered last holds the remote and reads the next question aloud.</div>' +
        hintBar([['OK', 'start']]);

    // ------------------------------------------------------------ setup

    case 'setupCount': {
      var tiles = '';
      for (var n = 2; n <= 4; n++) {
        tiles += '<div class="tile' + (setup.count === n ? ' sel' : '') + '">' + n + '</div>';
      }
      return '<div class="eyebrow">Setup</div><h1>How many playing?</h1>' +
        '<div class="tiles">' + tiles + '</div>' +
        '<div class="note">Players or teams. Nothing breaks at more, but the pacing is tuned for two to four.</div>' +
        hintBar([['←→', 'choose'], ['OK', 'confirm'], ['Back', 'undo']]);
    }

    case 'setupName': {
      var name = setup.names[setup.playerIdx] || '';
      var kb = '';
      for (var r = 0; r < KEYS.length; r++) {
        kb += '<div class="kbd-row">';
        for (var c = 0; c < KEYS[r].length; c++) {
          var k = KEYS[r][c];
          var wide = (k.length > 1);
          kb += '<div class="key' + (wide ? ' wide' : '') +
            (setup.row === r && setup.col === c ? ' sel' : '') + '">' + esc(k) + '</div>';
        }
        kb += '</div>';
      }
      return '<div class="eyebrow">Player ' + (setup.playerIdx + 1) + ' of ' + setup.count + '</div>' +
        '<div class="nameline">' + (esc(name) || '&nbsp;') + '</div>' + kb +
        '<div class="note">Leave it blank to be called Player ' + (setup.playerIdx + 1) + '.</div>' +
        hintBar([['↑↓←→', 'move'], ['OK', 'type'], ['Back', 'delete']]);
    }

    // ------------------------------------------------------------ draft

    case 'draft': {
      var d = S.draft;
      var vetoer = S.players[S.order[d.vetoerTurn]];
      var tiles = '';
      for (var i = 0; i < d.pool.length; i++) {
        var id = d.pool[i];
        var dead = d.vetoed.indexOf(id) !== -1;
        tiles += '<div class="tile wide' + (dead ? ' gone' : '') +
          (i === d.cursor && !dead ? ' sel' : '') + '">' + esc(bank.catName[id]) + '</div>';
      }
      return statusBar(['Veto <b>' + (d.vetoerTurn + 1) + '</b> of <b>' + d.vetoes + '</b>']) +
        '<h2>' + esc(vetoer.name) + ', kill one category</h2>' +
        '<div class="tiles">' + tiles + '</div>' +
        '<div class="note">What survives is the category list for the whole section. ' +
        'Pass the remote after your veto.</div>' +
        hintBar([['←→↑↓', 'move'], ['OK', 'veto'], ['Back', 'undo']]);
    }

    case 'sectionIntro': {
      var sec = section();
      return statusBar() +
        '<h1>Section ' + sec.number + '</h1>' +
        categoryLine() +
        '<div class="note">Ledger: ' + sec.ledger.join(', ') +
        '. Spend each value once. Higher values draw harder questions. ' +
        (S.sectionIndex === 1 ? 'Turn order is reversed for this section. ' : '') +
        'First up: <b>' + esc(currentPlayer().name) + '</b>.</div>' +
        playerStrip(currentPlayerIdx(), true) +
        hintBar([['OK', 'begin'], ['Back', 'undo']]);
    }

    // --------------------------------------------------------- the loop

    case 'wager': {
      var p = currentPlayer();
      var categoryId = S.categories[p.qIndex % S.categories.length];
      var tiles = '';
      for (var i = 0; i < section().ledger.length; i++) {
        var v = section().ledger[i];
        var spent = p.ledger.indexOf(v) === -1;
        var isCursor = !spent && p.ledger[S.wagerCursor] === v;
        tiles += '<div class="tile' + (spent ? ' spent' : '') + (isCursor ? ' sel' : '') + '">' + v + '</div>';
      }
      var value = p.ledger[S.wagerCursor];
      var tier = DIFFICULTY_NAMES[DIFFICULTY_FOR_VALUE[value]];
      return statusBar(['Up: <b>' + esc(p.name) + '</b>']) +
        '<div class="eyebrow">Category</div>' +
        '<h1>' + esc(bank.catName[categoryId]) + '</h1>' +
        '<div class="tiles">' + tiles + '</div>' +
        '<div class="note">Wagering <b>' + value + '</b> draws ' +
        (tier === 'Easy' ? 'an' : 'a') + ' <b>' + tier + '</b> question. ' +
        'Choose before any options are revealed.</div>' +
        playerStrip(currentPlayerIdx(), true) +
        hintBar([['←→', 'choose wager'], ['OK', 'lock it in'], ['Back', 'undo']]);
    }

    case 'question': {
      var q = S.q;
      var selecting = q.sel !== null;
      var hints = selecting
        ? [['←→', 'move'], ['OK', 'lock answer'], ['Back', 'keep revealing']]
        : [['OK', q.revealed < 4 ? 'reveal ' + ['A', 'B', 'C', 'D'][q.revealed] : 'choose answer'],
           ['←→', 'pick an answer'], ['Back', 'undo']];
      return statusBar(['Up: <b>' + esc(S.players[q.ownerIdx].name) + '</b>',
                        'Wager <b>' + q.value + '</b>',
                        DIFFICULTY_NAMES[q.difficulty]]) +
        categoryLine(q.categoryId) +
        '<div class="question">' + esc(q.text) + '</div>' +
        optionRows(q, { selIdx: q.sel }) +
        (q.revealed < 4 && !selecting
          ? '<div class="note">Locking before option D is revealed is worth +' +
            TUNING.earlyLockBonus + '.</div>'
          : '') +
        hintBar(hints);
    }

    case 'judge': {
      var r = S.result;
      var body;
      if (S.q && r.kind !== 'sweep') {
        body = categoryLine(S.q.categoryId) +
          '<div class="question">' + esc(S.q.text) + '</div>' +
          optionRows(S.q, { showResult: true, lockedIdx: S.q.lockedIdx });
      } else {
        body = '<div class="bignum">+' + TUNING.sweepBonus + '</div>';
      }
      var next = (r.kind === 'wrong') ? 'offer the steal' : 'continue';
      return statusBar() +
        '<div class="verdict ' + (r.good ? 'good' : 'bad') + '">' + esc(r.headline) + '</div>' +
        '<div class="note">' + esc(r.detail) + '</div>' +
        body +
        playerStrip(S.q ? S.q.ownerIdx : -1, true) +
        hintBar([['OK', next], ['Back', 'undo this judgment']]);
    }

    case 'steal': {
      var st = S.steal;
      var q = S.q;
      return statusBar(['Steal: <b>' + esc(S.players[st.playerIdx].name) + '</b>']) +
        '<div class="eyebrow">Worth ' + Math.ceil(q.value / 2) + ', costs nothing to miss</div>' +
        '<div class="question">' + esc(q.text) + '</div>' +
        optionRows(q, { selIdx: st.alive[st.cursor], dead: [q.lockedIdx] }) +
        hintBar([['←→', 'move'], ['OK', 'steal it'], ['↓', 'pass'], ['Back', 'undo']]);
    }

    // ----------------------------------------------------------- speed

    case 'speedIntro': {
      var p = S.players[speedPlayerIdx()];
      var clock = speedClockFor(p);
      var gap = leaderScore() - p.score;
      return '<div class="eyebrow">Speed Round</div>' +
        '<h1>' + esc(p.name) + '</h1>' +
        '<div class="clock">' + clock + '</div>' +
        '<div class="note">Free answer, no options. Shout it, the host presses OK to reveal, ' +
        'then marks it. One point each, no penalty for a miss, so guess fast.' +
        (gap >= 10 ? ' Extra time for trailing the leader by ' + gap + '.' : '') +
        '</div>' +
        hintBar([['OK', 'start the clock'], ['Back', 'undo']]);
    }

    case 'speedPlay': {
      var sp = S.speed;
      var q = sp.q;
      return statusBar(['<b>' + esc(S.players[speedPlayerIdx()].name) + '</b>',
                        'Correct <b>' + sp.correct + '</b>'], 'Speed Round') +
        '<div class="clock' + (sp.secondsLeft <= 5 ? ' low' : '') + '">' + sp.secondsLeft + '</div>' +
        '<div class="question">' + esc(q.q) + '</div>' +
        (sp.revealed
          ? '<div class="answer">' + esc(q.a) + '</div>' +
            hintBar([['→', 'correct'], ['←', 'wrong'], ['↓', 'skip']])
          : hintBar([['OK', 'reveal the answer'], ['↓', 'skip']]));
    }

    case 'speedResult': {
      var sp = S.speed;
      var p = S.players[speedPlayerIdx()];
      var last = sp.seat >= S.order.length - 1;
      return '<div class="eyebrow">Speed Round</div>' +
        '<h1>' + esc(p.name) + '</h1>' +
        '<div class="bignum">+' + sp.correct + '</div>' +
        '<div class="note">' + sp.correct + ' of ' + sp.asked + ' ' +
        plural(sp.asked, 'question', 'questions') + '.</div>' +
        playerStrip(speedPlayerIdx(), false) +
        hintBar([['OK', last ? 'to the final question' : 'next player'], ['Back', 'undo']]);
    }

    // ----------------------------------------------------------- final

    case 'finalIntro':
      return '<div class="eyebrow">Final Question</div>' +
        '<h1>' + esc(bank.catName[S.final.categoryId]) + '</h1>' +
        '<div class="note">Everyone locks a wager before the question is shown. ' +
        'Lowest score declares first. Wrong answers lose the wager.</div>' +
        playerStrip(-1, false) +
        hintBar([['OK', 'start wagering'], ['Back', 'undo']]);

    case 'finalWager': {
      var f = S.final;
      var idx = f.wagerOrder[f.wagerSeat];
      var p = S.players[idx];
      var cap = finalCapFor(p);
      var placed = f.wagerOrder.slice(0, f.wagerSeat).map(function (i) {
        return esc(S.players[i].name) + ' ' + f.wagers[i];
      }).join(' &nbsp;·&nbsp; ');
      return '<div class="eyebrow">Final wager · ' + esc(bank.catName[f.categoryId]) + '</div>' +
        '<h2>' + esc(p.name) + ' &nbsp;<span style="color:var(--dim)">' + p.score + ' points</span></h2>' +
        '<div class="bignum">' + f.wagerValue + '</div>' +
        '<div class="note">Anything from 0 to ' + cap + '. ' +
        'The ceiling moves so whoever is trailing can always catch the leader.</div>' +
        (placed ? '<div class="catlist">Already in: ' + placed + '</div>' : '') +
        hintBar([['←→', '±1'], ['↑↓', '±5'], ['OK', 'lock wager'], ['Back', 'undo']]);
    }

    case 'finalQuestion': {
      var f = S.final;
      return '<div class="eyebrow">Final Question · ' + esc(bank.catName[f.categoryId]) + '</div>' +
        '<div class="clock' + (f.secondsLeft <= 5 ? ' low' : '') + '">' + f.secondsLeft + '</div>' +
        '<div class="question">' + esc(f.question.q) + '</div>' +
        '<div class="note">Thinking time. Then each player says their answer aloud, in turn.</div>' +
        hintBar([['OK', 'reveal the answer'], ['Back', 'undo']]);
    }

    case 'finalReveal':
      return '<div class="eyebrow">Final Question</div>' +
        '<div class="question">' + esc(S.final.question.q) + '</div>' +
        '<div class="answer">' + esc(S.final.question.a) + '</div>' +
        hintBar([['OK', 'judge each player'], ['Back', 'undo']]);

    case 'finalJudge': {
      var f = S.final;
      var idx = f.wagerOrder[f.judgeSeat];
      var p = S.players[idx];
      return '<div class="eyebrow">Final · judging</div>' +
        '<h1>' + esc(p.name) + '</h1>' +
        '<div class="answer">' + esc(f.question.a) + '</div>' +
        '<div class="note">Wagered <b>' + f.wagers[idx] + '</b>. ' +
        'Right takes it to ' + (p.score + f.wagers[idx]) +
        ', wrong drops to ' + (p.score - f.wagers[idx]) + '.</div>' +
        hintBar([['→', 'right'], ['←', 'wrong'], ['Back', 'undo']]);
    }

    // ------------------------------------------------------- end states

    case 'sudden': {
      var sd = S.sudden;
      var tiles = sd.players.map(function (i, n) {
        return '<div class="tile wide' + (n === sd.cursor ? ' sel' : '') + '">' +
          esc(S.players[i].name) + '</div>';
      }).join('');
      return '<div class="eyebrow">Sudden death · ' + esc(bank.catName[sd.categoryId]) + '</div>' +
        '<div class="question">' + esc(sd.q.q) + '</div>' +
        (sd.revealed
          ? '<div class="answer">' + esc(sd.q.a) + '</div>' +
            '<div class="tiles">' + tiles + '</div>' +
            hintBar([['←→', 'who got it'], ['OK', 'they win'], ['↓', 'nobody, next question']])
          : '<div class="note">Tied. First correct answer wins.</div>' +
            hintBar([['OK', 'reveal the answer'], ['Back', 'undo']]));
    }

    case 'scoreboard': {
      var board = standings();
      var rows = board.map(function (r, i) {
        return '<div class="rank' + (i === 0 ? ' first' : '') + '">' +
          '<span class="pos">' + (i + 1) + '</span>' +
          '<span class="nm">' + esc(r.name) + '</span>' +
          '<span class="sc">' + r.score + '</span></div>';
      }).join('');
      return '<div class="eyebrow">Final</div>' +
        '<h1>' + esc(board[0].name) + ' wins</h1>' + rows +
        hintBar([['OK', 'play again'], ['Back', 'undo']]);
    }
  }
  return '<h1>…</h1>';
}

// ------------------------------------------------------------------- input

// Arrow keys and Enter map to the D-pad on essentially every TV browser.
// Coloured buttons are deliberately unused: their key codes vary wildly.
function actionFor(e) {
  switch (e.key) {
    case 'Enter': case ' ': case 'Spacebar': return 'OK';
    case 'ArrowLeft': case 'Left': return 'LEFT';
    case 'ArrowRight': case 'Right': return 'RIGHT';
    case 'ArrowUp': case 'Up': return 'UP';
    case 'ArrowDown': case 'Down': return 'DOWN';
    case 'Backspace': case 'Escape': case 'Esc': case 'GoBack': case 'BrowserBack':
      return 'BACK';
  }
  switch (e.keyCode) {
    case 13: case 32: return 'OK';
    case 37: return 'LEFT';
    case 38: return 'UP';
    case 39: return 'RIGHT';
    case 40: return 'DOWN';
    case 8: case 27: case 461: case 10009: return 'BACK';   // webOS / Tizen back
  }
  return null;
}

function wrap(i, n) { return ((i % n) + n) % n; }

function handle(a) {
  // ---------------------------------------------------------------- boot
  if (!S) {
    if (loadError) { if (a === 'OK') loadBank(); return; }
    if (!bank) return;
    if (!setup) {
      if (a === 'OK') { setup = { count: 4, playerIdx: 0, names: [], row: 0, col: 0, screen: 'setupCount' }; }
      renderSetup(); return;
    }
    handleSetup(a);
    return;
  }

  switch (S.screen) {

    case 'draft': {
      var d = S.draft;
      if (a === 'OK') { snapshot(); applyVeto(); break; }
      if (a === 'BACK') { undo(); return; }
      var step = (a === 'RIGHT' || a === 'DOWN') ? 1 : (a === 'LEFT' || a === 'UP') ? -1 : 0;
      if (!step) return;
      for (var i = 1; i <= d.pool.length; i++) {
        var probe = wrap(d.cursor + step * i, d.pool.length);
        if (d.vetoed.indexOf(d.pool[probe]) === -1) { d.cursor = probe; break; }
      }
      break;
    }

    case 'sectionIntro':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'OK') return;
      snapshot();
      S.screen = 'wager';
      S.wagerCursor = 0;
      break;

    case 'wager': {
      var p = currentPlayer();
      if (a === 'BACK') { undo(); return; }
      if (S.wagerCursor >= p.ledger.length) S.wagerCursor = 0;
      if (a === 'OK') { snapshot(); beginQuestion(p.ledger[S.wagerCursor]); break; }
      if (a === 'LEFT' || a === 'UP') S.wagerCursor = wrap(S.wagerCursor - 1, p.ledger.length);
      else if (a === 'RIGHT' || a === 'DOWN') S.wagerCursor = wrap(S.wagerCursor + 1, p.ledger.length);
      else return;
      break;
    }

    case 'question': {
      var q = S.q;
      if (a === 'BACK') {
        if (q.sel !== null) { q.sel = null; break; }   // back out to revealing
        undo(); return;
      }
      if (a === 'OK') {
        if (q.sel !== null) { snapshot(); lockAnswer(q.sel); break; }
        snapshot();
        if (q.revealed < 4) q.revealed++;
        else q.sel = 0;
        break;
      }
      if (a === 'LEFT' || a === 'RIGHT' || a === 'UP' || a === 'DOWN') {
        if (!q.revealed) return;
        var back = (a === 'LEFT' || a === 'UP');
        q.sel = (q.sel === null)
          ? (back ? q.revealed - 1 : 0)
          : wrap(q.sel + (back ? -1 : 1), q.revealed);
        break;
      }
      return;
    }

    case 'judge':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'OK') return;
      snapshot();
      if (S.result.kind === 'wrong' && !S.steal) offerSteal();
      else afterQuestionResolved();
      break;

    case 'steal': {
      var st = S.steal;
      if (a === 'BACK') { undo(); return; }
      if (a === 'OK') { snapshot(); resolveSteal(st.alive[st.cursor]); break; }
      if (a === 'DOWN') { snapshot(); afterQuestionResolved(); break; }
      if (a === 'LEFT') st.cursor = wrap(st.cursor - 1, st.alive.length);
      else if (a === 'RIGHT' || a === 'UP') st.cursor = wrap(st.cursor + 1, st.alive.length);
      else return;
      break;
    }

    // ----------------------------------------------------------- speed

    case 'speedIntro':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'OK') return;
      snapshot();
      startSpeedTurn();
      break;

    case 'speedPlay': {
      var sp = S.speed;
      if (!sp.running) return;

      // One level of undo inside the round: the host will misfire under a clock.
      if (a === 'BACK') {
        if (!sp.prev) return;
        sp.q = sp.prev.q;
        sp.asked = sp.prev.asked;
        sp.correct = sp.prev.correct;
        sp.revealed = true;
        sp.prev = null;
        break;
      }

      if (!sp.revealed) {
        if (a === 'OK') { sp.revealed = true; break; }
        if (a === 'DOWN') { sp.asked++; speedNextQuestion(); break; }
        return;
      }

      if (a === 'RIGHT' || a === 'LEFT' || a === 'DOWN') {
        sp.prev = { q: sp.q, asked: sp.asked, correct: sp.correct };
        sp.asked++;
        if (a === 'RIGHT') sp.correct++;
        speedNextQuestion();
        break;
      }
      return;
    }

    case 'speedResult':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'OK') return;
      snapshot();
      speedAdvanceSeat();
      break;

    // ----------------------------------------------------------- final

    case 'finalIntro':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'OK') return;
      snapshot();
      S.final.wagerValue = 0;
      S.screen = 'finalWager';
      break;

    case 'finalWager': {
      var f = S.final;
      if (a === 'BACK') { undo(); return; }
      var cap = finalCapFor(S.players[f.wagerOrder[f.wagerSeat]]);
      if (a === 'OK') { snapshot(); commitFinalWager(); break; }
      var delta = a === 'RIGHT' ? 1 : a === 'LEFT' ? -1 : a === 'UP' ? 5 : a === 'DOWN' ? -5 : 0;
      if (!delta) return;
      f.wagerValue = Math.max(0, Math.min(cap, f.wagerValue + delta));
      break;
    }

    case 'finalQuestion':
      if (a === 'BACK') { stopTimer(); undo(); return; }
      if (a !== 'OK') return;
      stopTimer();
      snapshot();
      S.screen = 'finalReveal';
      break;

    case 'finalReveal':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'OK') return;
      snapshot();
      S.final.judgeSeat = 0;
      S.screen = 'finalJudge';
      break;

    case 'finalJudge':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'RIGHT' && a !== 'LEFT') return;
      snapshot();
      commitFinalVerdict(a === 'RIGHT');
      break;

    // ------------------------------------------------------- end states

    case 'sudden': {
      var sd = S.sudden;
      if (a === 'BACK') { undo(); return; }
      if (!sd.revealed) {
        if (a !== 'OK') return;
        snapshot();
        sd.revealed = true;
        break;
      }
      if (a === 'OK') {
        snapshot();
        S.players[sd.players[sd.cursor]].score += 1;
        S.screen = 'scoreboard';
        break;
      }
      if (a === 'DOWN') { snapshot(); suddenNextQuestion(); break; }
      if (a === 'LEFT') sd.cursor = wrap(sd.cursor - 1, sd.players.length);
      else if (a === 'RIGHT') sd.cursor = wrap(sd.cursor + 1, sd.players.length);
      else return;
      break;
    }

    case 'scoreboard':
      if (a === 'BACK') { undo(); return; }
      if (a !== 'OK') return;
      S = null;
      setup = null;
      past = [];
      renderSetup();
      return;

    default:
      return;
  }

  render();
}

// ------------------------------------------------------------------- setup

function renderSetup() {
  document.getElementById('screen').innerHTML = view();
}

function handleSetup(a) {
  if (setup.screen === 'setupCount') {
    if (a === 'LEFT') setup.count = Math.max(2, setup.count - 1);
    else if (a === 'RIGHT') setup.count = Math.min(4, setup.count + 1);
    else if (a === 'OK') { setup.screen = 'setupName'; setup.playerIdx = 0; setup.names = []; }
    else if (a === 'BACK') { setup = null; }
    renderSetup();
    return;
  }

  var row = KEYS[setup.row];

  if (a === 'UP') { setup.row = wrap(setup.row - 1, KEYS.length); }
  else if (a === 'DOWN') { setup.row = wrap(setup.row + 1, KEYS.length); }
  else if (a === 'LEFT') { setup.col = wrap(setup.col - 1, row.length); }
  else if (a === 'RIGHT') { setup.col = wrap(setup.col + 1, row.length); }
  else if (a === 'BACK') {
    var cur = setup.names[setup.playerIdx] || '';
    setup.names[setup.playerIdx] = cur.slice(0, -1);
  } else if (a === 'OK') {
    var key = KEYS[setup.row][Math.min(setup.col, KEYS[setup.row].length - 1)];
    var name = setup.names[setup.playerIdx] || '';
    if (key === 'DONE') {
      setup.names[setup.playerIdx] = name.trim();
      setup.playerIdx++;
      if (setup.playerIdx >= setup.count) {
        var names = [];
        for (var i = 0; i < setup.count; i++) names.push(setup.names[i] || '');
        setup = null;
        past = [];
        newGame(names);
        render();
        return;
      }
      setup.row = 0; setup.col = 0;
    } else if (key === 'DEL') {
      setup.names[setup.playerIdx] = name.slice(0, -1);
    } else if (name.length < TUNING.maxNameLength) {
      setup.names[setup.playerIdx] = name + (key === 'SPACE' ? ' ' : key);
    }
  } else return;

  setup.col = Math.min(setup.col, KEYS[setup.row].length - 1);
  renderSetup();
}

// -------------------------------------------------------------------- boot

function loadBank() {
  loadError = null;
  renderSetup();
  fetch('/questions.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (raw) {
      bank = indexBank(raw);
      renderSetup();
    })
    .catch(function (e) {
      loadError = e.message;
      renderSetup();
    });
}

document.addEventListener('keydown', function (e) {
  var a = actionFor(e);
  if (!a) return;
  e.preventDefault();
  handle(a);
});

// A tap anywhere counts as OK, so the game is testable on a phone. Clicks
// synthesised from an Enter keypress carry detail 0; ignoring those stops a
// TV remote from advancing two screens on one press.
document.addEventListener('click', function (e) {
  if (e.detail > 0) handle('OK');
});

loadBank();
