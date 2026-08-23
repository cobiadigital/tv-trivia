'use strict';

/* Remote Trivia. One remote, one screen, no pairing.
   Everything below is deliberately ES2017-level: no optional chaining, no
   nullish coalescing, no structuredClone, no fetch. Old television engines
   choke on those, and a failure here means a screen stuck on "Loading
   questions" with no console to ask about it. */

// ------------------------------------------------------------------ tuning

// Kept in step with package.json by a test, since nothing at runtime can read
// package.json to derive it.
var VERSION = '0.1.13';

var TUNING = {
  speedBaseSeconds: 45,        // open question in the design doc: try 45 vs 60
  speedBonusPer10Behind: 5,
  speedBonusCap: 20,
  finalThinkSeconds: 30,
  earlyLockBonus: 1,
  sweepBonus: 3,
  maxNameLength: 10
};

// Difficulty belongs to the section, not the wager: section 1 is easy
// throughout, section 2 hard. The speed round sits between them and draws
// medium, so the game ramps rather than stepping.
// Tiers are 0 = easy, 1 = medium, 2 = hard.
var SECTIONS = [
  { number: 1, ledger: [1, 2, 3, 4], difficulty: 0, stealValue: 1 },
  { number: 2, ledger: [2, 3, 4, 5, 6], difficulty: 2, stealValue: 2 }
];

var SPEED_DIFFICULTY = 1;

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
      showAnswer: true,
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
  if (S.sectionIndex === 0) startSpeedRound();
  else startFinal();
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

  var q = drawQuestion(categoryId, section().difficulty, {});
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
      showAnswer: true,
      rollAgain: true
    };
    S.screen = 'judge';
    return;
  }

  p.missedThisSection = true;

  // Guessing early leaves options unrevealed, and handing the next player a
  // steal from one or two of them is no steal at all - the answer may not even
  // be among them. Show the rest of the board before the steal is offered.
  var lockedEarly = q.revealed < 4;
  q.revealed = 4;

  S.result = {
    kind: 'wrong',
    headline: 'Wrong',
    detail: p.name + ' burns the ' + q.value + '.' +
      (lockedEarly ? ' The rest of the board is up now.' : '') +
      ' The answer stays hidden for the steal.',
    good: false,
    showAnswer: false,
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

  var stealerTurn = (S.turn + 1) % S.order.length;
  var stealerIdx = S.order[stealerTurn];

  if (!alive.length || stealerIdx === q.ownerIdx) {
    revealAnswer('No steal', 'Nothing left for anyone else to take.', false);
    return;
  }

  S.steal = { playerIdx: stealerIdx, alive: alive, cursor: 0 };
  S.screen = 'steal';
}

// A miss keeps the correct answer hidden, otherwise the steal is a gift. Every
// way out of a miss ends here, which is where the answer finally goes up.
function revealAnswer(headline, detail, good) {
  S.result = {
    kind: 'reveal',
    headline: headline,
    detail: detail,
    good: good,
    showAnswer: true,
    rollAgain: false
  };
  S.screen = 'judge';
}

function resolveSteal(optionIdx) {
  var q = S.q;
  var p = S.players[S.steal.playerIdx];

  if (optionIdx === q.correctIdx) {
    var gained = section().stealValue;
    p.score += gained;
    S.result = {
      kind: 'steal',
      headline: 'Stolen',
      detail: p.name + ' takes +' + gained + '.',
      good: true,
      showAnswer: true,
      rollAgain: false
    };
  } else {
    S.result = {
      kind: 'stealFailed',
      headline: 'Steal failed',
      detail: 'No cost to ' + p.name + '. The ' + q.value + ' stays burned.',
      good: false,
      showAnswer: true,
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
  var q = drawQuestion(categoryId, SPEED_DIFFICULTY, { speakable: true });
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
  if (sp.seat < S.order.length) { S.screen = 'speedIntro'; return; }

  // Out of the speed round and into section 2, with the order flipped:
  // going last is a small edge, having watched everyone else burn questions.
  S.sectionIndex = 1;
  S.order = S.order.slice().reverse();
  startDraft();
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

var setup = null;
var loadError = null;

// The hint bar doubles as the touch control bar: every key it names is also a
// tappable chip dispatching the same action, so a phone or a mouse can drive
// every screen the remote can. The chips are divs rather than buttons - nothing
// on the page is focusable, so a TV browser that synthesises a click from Enter
// has no target to land on and cannot double-fire.
var GLYPH_ACTION = { '\u2190': 'LEFT', '\u2192': 'RIGHT', '\u2191': 'UP', '\u2193': 'DOWN' };

// Tokenises a hint label into chips: 'OK', 'Back' and the arrow glyphs each
// become one, so '\u2190\u2192' is two chips and 'OK / \u2193' is two as well.
// Anything else in the label is a separator and is dropped.
function hintChips(label) {
  var out = [];
  var i = 0;
  while (i < label.length) {
    if (label.substr(i, 2) === 'OK') { out.push(['OK', 'OK']); i += 2; continue; }
    if (label.substr(i, 4) === 'Back') { out.push(['Back', 'BACK']); i += 4; continue; }
    var ch = label.charAt(i);
    if (GLYPH_ACTION[ch]) out.push([ch, GLYPH_ACTION[ch]]);
    i += 1;
  }
  return out.length ? out : [[label, null]];
}

// On the title screen only - including its loading and error states, which are
// the same screen and exactly when knowing the version is most useful.
function versionTag() {
  return '<div class="version">v' + esc(VERSION) +
    '<span class="lastkey" id="lastkey">' + esc(lastKey) + '</span></div>';
}

// Shown on the title screen only, and empty until a key actually arrives. On a
// television there is no console to ask which keys the remote sends - and on
// webOS the answer is "not the arrows" - so the screen answers it instead.
var lastKey = '';

function reportKey(e) {
  var name = e.key ? String(e.key) : '?';
  var code = e.keyCode || e.which || 0;
  reportInput(name + ' \u00b7 ' + code);
}

function reportInput(text) {
  lastKey = text;
  var node = document.getElementById('lastkey');
  if (node) node.textContent = lastKey;
}

function hintBar(pairs) {
  var html = pairs.map(function (p) {
    var chips = hintChips(p[0]).map(function (c) {
      if (!c[1]) return '<span class="hint-key dead">' + esc(c[0]) + '</span>';
      return '<span class="hint-key" role="button" data-act="' + c[1] + '">' +
        esc(c[0]) + '</span>';
    }).join('');
    return '<span class="hint">' + chips +
      '<span class="hint-label">' + esc(p[1]) + '</span></span>';
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

// A television has no scrollbar and `overflow: hidden`, so anything that does
// not fit is simply lost - including the hint bar, which is the only thing
// telling the host what the buttons do. Rather than hope the content fits,
// pick a type scale from how much of it there actually is. `bump` accounts for
// whatever else the screen is carrying above the question.
function densityClass(q, bump) {
  var chars = q.text.length;
  for (var i = 0; i < q.options.length; i++) chars += q.options[i].length;
  var level = chars > 260 ? 3 : chars > 170 ? 2 : chars > 110 ? 1 : 0;
  level = Math.min(3, level + (bump || 0));
  return level ? ' dense-' + level : '';
}

function questionBlock(q, opts, bump) {
  return '<div class="qblock' + densityClass(q, bump) + '">' +
    '<div class="question">' + esc(q.text) + '</div>' +
    (opts ? optionRows(q, opts) : '') +
    '</div>';
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
      if (i === q.correctIdx && !opts.hideCorrect) cls += ' correct';
      else if (i === opts.lockedIdx) cls += ' wrong';
    }

    var pickable = opts.pickable && opts.pickable.indexOf(i) !== -1;
    if (pickable) cls += ' tappable';

    html += '<div class="' + cls + '"' +
      (pickable ? ' role="button" data-pick="' + i + '"' : '') +
      '><span class="letter">' + letters[i] + '</span>' + text + '</div>';
  }
  return html + '</div>';
}

function render() {
  var el = document.getElementById('screen');
  el.innerHTML = view();
  layoutShell();
  shrinkToFit();
  fitToScreen();
}

// The density steps above are coarse and bottom out after three of them, at
// which point the content region simply scrolled. On a phone held sideways -
// roughly 400px tall once the browser has taken its share - that meant half the
// board below the fold. Everything here is sized in rem, so scaling the root
// font size scales the whole layout with it, and a couple of measured passes
// land on the largest size that actually fits.
//
// Televisions are left alone: their type is sized to be read from a sofa, and
// the density steps plus the fit test already guarantee a whole screen.
var MIN_FIT_SCALE = 0.62;

function fitToScreen() {
  var root = document.documentElement;
  if (!root || !root.style || !window.getComputedStyle) return;

  root.style.fontSize = '';                   // always measure from the base
  var scroller = document.querySelector('.screen-scroll');
  if (!scroller || !scroller.scrollHeight || !scrollsItsOwnContent(scroller)) return;

  var base = parseFloat(getComputedStyle(root).fontSize) || 18;
  var scale = 1;

  // Shrinking the root also shrinks the padding and the gaps, so the space to
  // fill grows as the content shrinks. Re-measure rather than solve for it.
  for (var pass = 0; pass < 4; pass++) {
    if (scroller.scrollHeight <= scroller.clientHeight + 1) break;
    scale = Math.max(MIN_FIT_SCALE,
      scale * (scroller.clientHeight / scroller.scrollHeight));
    root.style.fontSize = (base * scale) + 'px';
    if (scale <= MIN_FIT_SCALE) break;
  }
}

// True only where the shell is active, which is the small-screen layout.
function scrollsItsOwnContent(scroller) {
  var overflow = getComputedStyle(scroller).overflowY;
  return overflow === 'auto' || overflow === 'scroll';
}

// Every view emits its hint bar last. Move everything ahead of it into its own
// scrolling region, so the bar is an ordinary sibling that content scrolls
// inside of, never underneath. Doing it here keeps the twenty-odd view cases
// free of layout scaffolding.
//
// This replaces a bar that was position:fixed over a scrolling page, with
// script measuring its height so the page could reserve room below. That rested
// on three things that all behave differently in a standalone PWA window: a
// fixed element above a body-scrolled page, the document being the scroller,
// and a measured height staying current across a rotation. Nothing here is
// fixed and nothing is measured, so the bar cannot be painted over the content
// and there is no reserve to go stale.
function layoutShell() {
  var screen = document.getElementById('screen');
  if (!screen || !screen.querySelector || !document.createElement) return;

  var hints = screen.querySelector('.hints');
  if (!hints) return;

  var scroll = document.createElement('div');
  scroll.className = 'screen-scroll';
  while (screen.firstChild && screen.firstChild !== hints) {
    scroll.appendChild(screen.firstChild);
  }
  screen.insertBefore(scroll, hints);
}

// densityClass() guesses a type scale from how much text there is. This checks
// what actually happened and steps the scale down until the screen genuinely
// fits. Question and option lengths vary far too much - and viewports differ
// too much - for any fixed budget to hold everywhere. Without it the tail of
// the board ends up under the control bar, visible but dead to a tap.
function shrinkToFit() {
  var root = document.documentElement;
  var block = document.querySelector('.qblock');
  if (!root || !block || !block.className) return;

  var scroller = document.querySelector('.screen-scroll');
  var match = /dense-(\d)/.exec(block.className);
  var level = match ? Number(match[1]) : 0;

  while (level < 3 && doesNotFit(scroller, root)) {
    level++;
    block.className = 'qblock dense-' + level;
  }
}

// Small screens scroll inside .screen-scroll; a television does not scroll at
// all and overflows the document instead. Either one means it did not fit.
function doesNotFit(scroller, root) {
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) return true;
  return root.scrollHeight > root.clientHeight;
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
      return versionTag() +
        '<h1>Remote Trivia</h1><div class="note">Loading questions…</div>';

    case 'error':
      return versionTag() +
        '<h1>Could not load questions</h1>' +
        '<div class="note">' + esc(loadError) + '</div>' +
        '<div class="note diag">' +
        esc((typeof navigator !== 'undefined' && navigator.userAgent) || '') +
        '</div>' +
        hintBar([['OK', 'retry']]);

    case 'attract':
      return versionTag() +
        '<div class="eyebrow">One remote. One screen.</div>' +
        '<h1>Remote Trivia</h1>' +
        '<div class="note">' + bank.questions.length + ' questions loaded across ' +
        Object.keys(bank.byCat).length + ' categories. ' +
        'Whoever answered last holds the remote and reads the next question aloud.</div>' +
        hintBar([['OK', 'start']]);

    // ------------------------------------------------------------ setup

    case 'setupCount': {
      var tiles = '';
      for (var n = 2; n <= 4; n++) {
        tiles += '<div class="tile tappable' + (setup.count === n ? ' sel' : '') +
          '" role="button" data-pick="' + (n - 2) + '">' + n + '</div>';
      }
      return versionTag() +
        '<div class="eyebrow">Setup</div><h1>How many playing?</h1>' +
        '<div class="tiles">' + tiles + '</div>' +
        '<div class="note">Players or teams. Nothing breaks at more, but the pacing is tuned for two to four.</div>' +
        hintBar([['←→', 'choose'], ['OK', 'confirm'], ['Back', 'undo']]);
    }

    case 'setupName': {
      var name = setup.names[setup.playerIdx] || '';
      var already = setup.names.slice(0, setup.playerIdx).map(function (n, i) {
        return esc(n || ('Player ' + (i + 1)));
      }).join(' &nbsp;·&nbsp; ');
      // A real text field, so the TV's own keyboard does the typing. Every TV
      // browser has one; a D-pad grid was only ever a worse version of it.
      return versionTag() +
        '<div class="eyebrow">Player ' + (setup.playerIdx + 1) + ' of ' + setup.count + '</div>' +
        '<h2>Who is playing?</h2>' +
        '<input class="namefield" id="namefield" type="text" ' +
        'maxlength="' + TUNING.maxNameLength + '" value="' + esc(name) + '" ' +
        'placeholder="Player ' + (setup.playerIdx + 1) + '" ' +
        'autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false">' +
        (already ? '<div class="catlist">' + already + '</div>' : '') +
        '<div class="note">Leave it blank to be called Player ' +
        (setup.playerIdx + 1) + '.</div>' +
        hintBar([['OK / \u2193',
                  setup.playerIdx + 1 < setup.count ? 'next player' : 'start the game'],
                 ['\u2191', 'previous']]);
    }

    // ------------------------------------------------------------ draft

    case 'draft': {
      var d = S.draft;
      var vetoer = S.players[S.order[d.vetoerTurn]];
      var tiles = '';
      for (var i = 0; i < d.pool.length; i++) {
        var id = d.pool[i];
        var dead = d.vetoed.indexOf(id) !== -1;
        tiles += '<div class="tile wide' + (dead ? ' gone' : ' tappable') +
          (i === d.cursor && !dead ? ' sel' : '') + '"' +
          (dead ? '' : ' role="button" data-pick="' + i + '"') +
          '>' + esc(bank.catName[id]) + '</div>';
      }
      return statusBar(['Veto <b>' + (d.vetoerTurn + 1) + '</b> of <b>' + d.vetoes + '</b>']) +
        '<h2>' + esc(vetoer.name) + ', kill one category</h2>' +
        '<div class="tiles">' + tiles + '</div>' +
        '<div class="note">What survives is the category list for the whole section. ' +
        'Pass the remote after your veto.</div>' +
        hintBar([['←→↑↓', 'move'], ['OK', 'veto'], ['1-' + d.pool.length, 'veto by number'],
                 ['Back', 'undo']]);
    }

    case 'sectionIntro': {
      var sec = section();
      return statusBar() +
        '<h1>Section ' + sec.number + '</h1>' +
        categoryLine() +
        '<div class="note">Ledger: ' + sec.ledger.join(', ') +
        '. Spend each value once. Every question this section is <b>' +
        DIFFICULTY_NAMES[sec.difficulty].toLowerCase() + '</b>. ' +
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
        tiles += '<div class="tile' + (spent ? ' spent' : ' tappable') +
          (isCursor ? ' sel' : '') + '"' +
          (spent ? '' : ' role="button" data-pick="' + i + '"') +
          '>' + v + '</div>';
      }
      var value = p.ledger[S.wagerCursor];
      return statusBar(['Up: <b>' + esc(p.name) + '</b>']) +
        '<div class="eyebrow">Category</div>' +
        '<h1>' + esc(bank.catName[categoryId]) + '</h1>' +
        '<div class="tiles">' + tiles + '</div>' +
        '<div class="note">Worth <b>' + value + '</b> if you get it. ' +
        'Spend each value once, so put your big ones on the categories you ' +
        'know. Choose before any options are revealed.</div>' +
        playerStrip(currentPlayerIdx(), true) +
        hintBar([['←→', 'choose wager'], ['OK', 'lock it in'],
                 [section().ledger[0] + '-' + section().ledger[section().ledger.length - 1],
                  'wager that value'],
                 ['Back', 'undo']]);
    }

    case 'question': {
      var q = S.q;
      var selecting = q.sel !== null;
      var hints = selecting
        ? [['←→', 'move'], ['OK', 'lock answer'], ['Back', 'keep revealing']]
        : [['OK', q.revealed < 4 ? 'reveal ' + ['A', 'B', 'C', 'D'][q.revealed] : 'choose answer'],
           ['←→', 'pick an answer'], ['Back', 'undo']];
      if (q.revealed) {
        hints.splice(1, 0, ['1-' + q.revealed,
          'lock ' + ['A', 'B', 'C', 'D'].slice(0, q.revealed).join('')]);
      }
      var pickable = [];
      for (var pi = 0; pi < q.revealed; pi++) pickable.push(pi);
      if (q.revealed < 4) pickable.push(q.revealed);   // tap the next slot to reveal it
      return statusBar(['Up: <b>' + esc(S.players[q.ownerIdx].name) + '</b>',
                        'Wager <b>' + q.value + '</b>',
                        DIFFICULTY_NAMES[q.difficulty]]) +
        categoryLine(q.categoryId) +
        questionBlock(q, { selIdx: q.sel, pickable: pickable }, 0) +
        (q.revealed < 4 && !selecting
          ? '<div class="note">Locking before option D is revealed is worth +' +
            TUNING.earlyLockBonus + '.</div>'
          : '') +
        hintBar(hints);
    }

    case 'judge': {
      var r = S.result;
      var showsQuestion = !!(S.q && r.kind !== 'sweep');
      var next = (r.kind === 'wrong') ? 'offer the steal' : 'continue';
      var body;

      if (showsQuestion) {
        body = categoryLine(S.q.categoryId) +
          questionBlock(S.q, { showResult: true, lockedIdx: S.q.lockedIdx,
                               hideCorrect: !r.showAnswer }, 2);
      } else {
        body = '<div class="bignum">+' + TUNING.sweepBonus + '</div>';
      }

      return statusBar() +
        '<div class="verdict' + (showsQuestion ? ' tight' : '') +
        (r.good ? ' good' : ' bad') + '">' + esc(r.headline) + '</div>' +
        '<div class="note">' + esc(r.detail) + '</div>' +
        body +
        // No score strip when the question block is up: it is what pushes this
        // screen off the bottom of a television, the detail line above already
        // states the points, and the next wager screen shows every score.
        (showsQuestion ? '' : playerStrip(-1, true)) +
        hintBar([['OK', next], ['Back', 'undo this judgment']]);
    }

    case 'steal': {
      var st = S.steal;
      var q = S.q;
      return statusBar(['Steal: <b>' + esc(S.players[st.playerIdx].name) + '</b>']) +
        '<div class="eyebrow">Worth ' + section().stealValue +
        ', costs nothing to miss</div>' +
        questionBlock(q, { selIdx: st.alive[st.cursor], dead: [q.lockedIdx],
                           pickable: st.alive }, 1) +
        hintBar([['←→', 'move'], ['OK', 'steal it'],
                 ['1-4', 'steal by letter'], ['↓', 'pass'], ['Back', 'undo']]);
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
        hintBar([['←→', '±1'], ['↑↓', '±5'], ['0-9', 'type it'],
                 ['OK', 'lock wager'], ['Back', 'undo']]);
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
        return '<div class="tile wide tappable' + (n === sd.cursor ? ' sel' : '') +
          '" role="button" data-pick="' + n + '">' + esc(S.players[i].name) + '</div>';
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

// The LG Magic Remote drives an on-screen pointer with its D-pad, and webOS
// eats the arrow keys before the page ever sees them. Its number buttons may
// therefore be the only keys that reach us, so every screen with a list on it
// takes a number as a direct shortcut to the nth thing.
function digitFor(e) {
  var key = e.key;
  if (key && key.length === 1 && key >= '0' && key <= '9') return Number(key);
  var code = e.keyCode || e.which || 0;
  if (code >= 48 && code <= 57) return code - 48;      // number row
  if (code >= 96 && code <= 105) return code - 96;     // numeric keypad
  return null;
}

// A number commits straight away rather than selecting first. Unlike a stray
// tap or a nudged pointer, pressing 3 is unambiguous - and Back undoes it.
function handleDigit(n) {
  if (!S) {
    if (setup && setup.screen === 'setupCount' && n >= 2 && n <= 4) {
      setup.count = n;
      handleSetup('OK');
    }
    return;
  }

  switch (S.screen) {
    case 'draft': {
      var d = S.draft;
      var slot = n - 1;
      if (slot < 0 || slot >= d.pool.length) return;
      if (d.vetoed.indexOf(d.pool[slot]) !== -1) return;
      snapshot();
      d.cursor = slot;
      applyVeto();
      break;
    }

    case 'wager': {
      // The number IS the wager here, not a position in the list.
      var player = currentPlayer();
      var at = player.ledger.indexOf(n);
      if (at === -1) return;
      snapshot();
      S.wagerCursor = at;
      beginQuestion(n);
      break;
    }

    case 'question': {
      var q = S.q;
      var pick = n - 1;
      if (pick < 0 || pick >= q.revealed) return;    // not shown yet
      snapshot();
      q.sel = pick;
      lockAnswer(pick);
      break;
    }

    case 'steal': {
      var st = S.steal;
      var target = st.alive.indexOf(n - 1);
      if (target === -1) return;
      snapshot();
      st.cursor = target;
      resolveSteal(n - 1);
      break;
    }

    case 'finalWager': {
      // Digits build the number, so a wager of 23 is two presses. Anything that
      // would overshoot the cap starts again from the digit just pressed, which
      // also makes 0 the way to clear it.
      var f = S.final;
      var cap = finalCapFor(S.players[f.wagerOrder[f.wagerSeat]]);
      var built = f.wagerValue * 10 + n;
      f.wagerValue = built <= cap ? built : (n <= cap ? n : cap);
      break;
    }

    case 'sudden': {
      var sd = S.sudden;
      if (!sd.revealed) return;
      var winner = n - 1;
      if (winner < 0 || winner >= sd.players.length) return;
      snapshot();
      sd.cursor = winner;
      S.players[sd.players[winner]].score += 1;
      S.screen = 'scoreboard';
      break;
    }

    default:
      return;
  }

  render();
}

function handle(a) {
  lastPick = null;     // a key press cancels any pending pointer confirmation

  // ---------------------------------------------------------------- boot
  if (!S) {
    if (loadError) { if (a === 'OK') loadBank(); return; }
    if (!bank) return;
    if (!setup) {
      if (a === 'OK') { setup = { count: 4, playerIdx: 0, names: [], screen: 'setupCount' }; }
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
      if (a === 'DOWN') {
        snapshot();
        st.done = true;
        revealAnswer('Passed', S.players[st.playerIdx].name + ' passed on the steal.', false);
        break;
      }
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
  layoutShell();
  shrinkToFit();
  fitToScreen();
  focusNameField();
}

// Focusing the field is what summons the TV's built-in keyboard, so it is the
// whole point of the screen rather than a nicety.
function focusNameField() {
  if (!setup || setup.screen !== 'setupName') return;
  var field = document.getElementById('namefield');
  if (!field || !field.focus) return;
  field.focus();
  if (field.setSelectionRange) {
    try { field.setSelectionRange(field.value.length, field.value.length); }
    catch (e) { /* some engines refuse this on a freshly attached node */ }
  }
}

function isTyping() {
  var el = document.activeElement;
  return !!(el && el.tagName === 'INPUT');
}

function handleSetup(a) {
  if (setup.screen === 'setupCount') {
    if (a === 'LEFT') setup.count = 2 + wrap(setup.count - 3, 3);
    else if (a === 'RIGHT') setup.count = 2 + wrap(setup.count - 1, 3);
    else if (a === 'OK') { setup.screen = 'setupName'; setup.playerIdx = 0; setup.names = []; }
    else if (a === 'BACK') { setup = null; }
    renderSetup();
    return;
  }

  if (a === 'BACK' || a === 'UP') {
    readNameField();
    if (setup.playerIdx > 0) setup.playerIdx--;
    else setup.screen = 'setupCount';
    renderSetup();
    return;
  }

  if (a !== 'OK' && a !== 'DOWN') return;

  readNameField();
  var name = (setup.names[setup.playerIdx] || '').trim();
  setup.names[setup.playerIdx] = name;
  setup.playerIdx++;

  if (setup.playerIdx < setup.count) { renderSetup(); return; }

  var names = [];
  for (var i = 0; i < setup.count; i++) names.push(setup.names[i] || '');
  setup = null;
  past = [];
  newGame(names);
  render();
}

// The field is the source of truth while it is on screen: `input` events keep
// setup.names in step, but a TV keyboard that commits its buffer without
// firing one would otherwise be lost.
function readNameField() {
  var field = document.getElementById('namefield');
  if (field && typeof field.value === 'string') {
    setup.names[setup.playerIdx] = field.value;
  }
}

// -------------------------------------------------------------------- boot

// XMLHttpRequest rather than fetch. A webOS television can be running an engine
// as old as Chromium 38, which has no fetch at all - and because the call sat at
// the top of a promise chain, a missing fetch threw before any promise existed,
// so nothing caught it. The script died with the screen still reading "Loading
// questions", which is exactly as informative as it sounds.
function loadBank() {
  loadError = null;
  renderSetup();

  var settled = false;

  function fail(reason) {
    if (settled) return;
    settled = true;
    loadError = reason;
    renderSetup();
  }

  var request;
  try {
    request = new XMLHttpRequest();
  } catch (e) {
    fail('this browser has no XMLHttpRequest');
    return;
  }

  request.onreadystatechange = function () {
    if (settled || request.readyState !== 4) return;

    // Some television browsers proxy requests and report status 0 on success.
    var served = request.status === 200 ||
      (request.status === 0 && request.responseText);
    if (!served) {
      fail('questions.json returned HTTP ' + request.status);
      return;
    }

    var raw;
    try {
      raw = JSON.parse(request.responseText);
    } catch (parseError) {
      fail('questions.json did not parse: ' + parseError.message);
      return;
    }

    try {
      bank = indexBank(raw);
    } catch (indexError) {
      fail('could not read the question bank: ' + indexError.message);
      return;
    }

    settled = true;
    renderSetup();
  };

  request.onerror = function () { fail('could not reach questions.json'); };
  request.ontimeout = function () { fail('questions.json timed out'); };

  try {
    request.open('GET', 'questions.json', true);
    request.timeout = 30000;      // never hang on "Loading questions" again
    request.send();
  } catch (sendError) {
    fail('could not request questions.json: ' + sendError.message);
  }
}

// A television has no console and no developer tools. Anything that would
// otherwise kill the script silently gets painted where it can be read off the
// screen, along with the user agent, since knowing which engine it is tends to
// be most of the answer.
function fatal(message) {
  var el = document.getElementById('screen');
  if (!el) return;
  var agent = (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown';
  el.innerHTML =
    '<div class="version">v' + esc(VERSION) + '</div>' +
    '<h1>Something went wrong</h1>' +
    '<div class="note">' + esc(message) + '</div>' +
    '<div class="note diag">' + esc(agent) + '</div>' +
    '<div class="note">Reload the page to start again.</div>';
}

// ----------------------------------------------------------- pointer input

// Pointer is the secondary input. The remote drives everything; a mouse or a
// finger reaches the same actions through the hint chips and the on-screen
// targets. Tapping a target moves the cursor to it, and tapping it again
// confirms - the same arrow-then-OK the remote does, so a stray tap cannot
// lock an answer or burn a wager on its own.
// The pending pointer confirmation. Arming is tracked separately from the
// cursor, because the cursor already sits on the first target when a screen
// opens - keying off it would make the first tile a one-tap commit while every
// other one took two.
var lastPick = null;

// `sig` identifies what is actually on screen - the player whose wager this is,
// the question being answered. Without it an arming could survive a turn
// change, and the next player's first tap would commit instead of select.
function armed(index, sig) {
  var key = currentScreen() + '|' + index + '|' + (sig === undefined ? '' : sig);
  var hit = (lastPick === key);
  lastPick = key;
  return hit;
}

function handlePick(index) {
  if (!S) { pickSetup(index); return; }

  switch (S.screen) {
    case 'draft': {
      var d = S.draft;
      if (d.vetoed.indexOf(d.pool[index]) !== -1) return;
      d.cursor = index;
      if (!armed(index, d.vetoerTurn)) break;
      snapshot();
      applyVeto();
      break;
    }

    case 'wager': {
      var p = currentPlayer();
      var value = section().ledger[index];
      var slot = p.ledger.indexOf(value);
      if (slot === -1) return;                     // already spent
      S.wagerCursor = slot;
      if (!armed(index, currentPlayerIdx())) break;
      snapshot();
      beginQuestion(value);
      break;
    }

    case 'question': {
      var q = S.q;
      // Tapping the next blank slot reveals it: that is not destructive, so it
      // does not need confirming.
      if (q.revealed < 4 && index === q.revealed) {
        lastPick = null;
        snapshot();
        q.revealed++;
        break;
      }
      if (index >= q.revealed) return;
      q.sel = index;
      if (!armed(index, q.id)) break;
      snapshot();
      lockAnswer(index);
      break;
    }

    case 'steal': {
      var st = S.steal;
      var at = st.alive.indexOf(index);
      if (at === -1) return;
      st.cursor = at;
      if (!armed(index, S.q.id)) break;
      snapshot();
      resolveSteal(index);
      break;
    }

    case 'sudden': {
      var sd = S.sudden;
      if (!sd.revealed) return;
      sd.cursor = index;
      if (!armed(index, sd.q.id)) break;
      snapshot();
      S.players[sd.players[index]].score += 1;
      S.screen = 'scoreboard';
      break;
    }

    default:
      return;
  }

  render();
}

function pickSetup(index) {
  if (!setup || setup.screen !== 'setupCount') return;
  var confirm = armed(index);
  setup.count = index + 2;
  if (confirm) { handleSetup('OK'); return; }
  renderSetup();
}

// ------------------------------------------------------------------ wiring

document.addEventListener('keydown', function (e) {
  reportKey(e);
  var a = actionFor(e);

  // While a text field has focus every key belongs to it and to the keyboard
  // the TV has put on screen - arrows move the caret or the IME's own
  // selection, Backspace deletes. Only Enter is ours, as "done with this name".
  if (isTyping()) {
    // Enter is ambiguous across TV browsers: some deliver it here, others keep
    // it to raise their own keyboard. Down always reaches us, so it is the one
    // that is guaranteed to get you off this screen.
    if (a === 'OK' || a === 'DOWN') { e.preventDefault(); handle('OK'); }
    else if (a === 'UP') { e.preventDefault(); handle('BACK'); }
    return;
  }

  var digit = digitFor(e);
  if (digit !== null) {
    e.preventDefault();
    lastPick = null;
    handleDigit(digit);
    return;
  }

  if (!a) return;
  e.preventDefault();
  handle(a);
});

// Typing does not re-render: the field owns its own text, and rebuilding the
// screen on every keystroke would drop focus and dismiss the TV's keyboard.
document.addEventListener('input', function (e) {
  if (setup && e.target && e.target.id === 'namefield') {
    setup.names[setup.playerIdx] = e.target.value;
  }
});

/* Delegated from #screen rather than document: iOS is unreliable about
   bubbling clicks on non-interactive elements as far as the document, but a
   real element ancestor gets them, and every target lives inside this one. */
document.getElementById('screen').addEventListener('click', function (e) {
  var node = e.target;
  while (node && node !== document.body) {
    if (node.getAttribute) {
      var act = node.getAttribute('data-act');
      if (act) { reportInput('tap ' + act); handle(act); return; }

      var pick = node.getAttribute('data-pick');
      if (pick !== null && pick !== '') {
        reportInput('tap #' + (Number(pick) + 1));
        handlePick(Number(pick));
        return;
      }
    }
    node = node.parentNode;
  }
});

// A rotation re-lays-out everything and the type scale has to be recomputed
// from scratch, since shrinkToFit only ever steps down and cannot recover on
// its own.
function relayout() {
  if (isTyping()) return;          // a keyboard opening is not a rotation
  if (setup) renderSetup();
  else if (S) render();
}

window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', relayout);

// Installed before the first load, so a failure during boot is reported rather
// than leaving the screen reading "Loading questions" for ever.
window.onerror = function (message, source, line) {
  fatal(String(message) + (line ? '  (line ' + line + ')' : ''));
  return false;
};

loadBank();
