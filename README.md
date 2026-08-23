# Remote Trivia

A TV-browser trivia game driven entirely by one remote. No pairing, no second
screens, no typing. The remote passes to whoever is hosting the current
question.

Full rules are in [`docs/design.md`](docs/design.md).

## How it runs

The whole game is client-side. The question bank is a static JSON file, game
state lives in the browser, and nothing is persisted between sessions. That
means the Worker needs no D1 database, no KV namespace and no bindings — a
merge to `main` deploys and the game works.

```
public/index.html    shell
public/style.css     TV-first styling, 5% overscan-safe margin
public/app.js        the entire game: state machine, rendering, input
public/questions.json  pre-harvested question bank
src/index.js         Worker: /api/health, plus a fallback to index.html
```

`src/index.js` only handles paths that aren't files in `public/`. If the game
later needs server state, that's where it goes.

## Fitting a television

A TV has no scrollbar and the body does not scroll, so anything past the bottom
edge is simply lost — including the hint bar, the only thing telling the host
what the buttons do. Question and option type therefore scales to how much text
there actually is (`densityClass` in `app.js`), rather than to a fixed size that
happens to fit the average question.

`npm run test:pointer` measures every question-bearing screen at 1920×1080 and
1280×720 with worst-case content and fails if anything overflows or if the hint
bar ends below the fold.

Phones are the opposite case and scroll instead; see **Small screens**.

## Playing

Open the deployed URL in the TV browser. Everything maps to the D-pad:

| Input | Meaning |
|---|---|
| OK / Enter | Advance, reveal, confirm, lock |
| Left / Right | Move between options or wager values |
| Up / Down | Secondary selection |
| Back | Undo the last action, including a misjudgment |

Coloured remote buttons are deliberately unused: their key codes vary wildly
across Tizen, webOS, Fire TV and Android TV.

### Entering names

Setup uses a real `<input type="text">`, focused on arrival. Every TV browser
brings up its own on-screen keyboard for a focused text field, and that keyboard
is better than anything this app could draw: it knows the remote, it has the
platform's own text prediction, and on many sets it accepts voice input.

The one wrinkle is Enter. Some TV browsers deliver it to the page; others keep
it to raise their keyboard. So **Down** also moves to the next player, and Up
goes back — Down always reaches the page, which makes it the key that cannot
strand you on the field. Both are named in the hint bar.

While the field has focus, every other key belongs to it: arrows move the caret
or the keyboard's own selection, and Backspace deletes. Typing never re-renders
the screen, because rebuilding it would drop focus and dismiss the keyboard.

### Mouse and touch

The remote is the primary input; a mouse or a finger is a supported second one,
useful for a laptop, a tablet, or playtesting on a phone.

Every screen prints its own key map along the bottom, and each key in that map
is also a tappable chip that fires the same action — so the hint bar doubles as
the touch control bar and no screen is reachable only by keyboard. On-screen
targets are directly tappable too: categories, ledger values, and answer
options.

Tapping a target selects it; tapping it again commits. That mirrors the
remote's arrow-then-OK, and means a stray tap can't burn a wager or lock an
answer. The one exception is deliberate: tapping the next blank answer slot
reveals it, which isn't destructive.

Pointer support adds no meaning of its own. The focus ring drawn for the remote
stays the single source of truth about what is selected, hover is never load-
bearing, and nothing on the page is focusable — which also stops TV browsers
that synthesise a click from Enter from firing an action twice.

### Small screens

The television layout assumes a screen that can show a whole state at once
inside a 5% overscan margin. A phone can do neither, so below 800px wide — or
below 550px tall, which is a phone held sideways — the layout changes rather
than just shrinking:

- The overscan margin gives way to the safe-area insets. The viewport is
  `viewport-fit=cover`, so without `env(safe-area-inset-*)` the Dynamic Island
  and the home indicator would sit on top of the game.
- Content scrolls instead of being clipped. On a television everything must
  fit; on a phone it can't, at a legible size.
- The hint bar sticks to the bottom of the viewport. On touch those chips are
  the controls, so they shouldn't scroll away.
- Type and spacing step down, and categories go full width — they're too long
  to sit two-up, and full width makes them the easiest thing to hit.

The root font size is fixed on phones rather than scaled to viewport height:
`2.2vh` is right for a panel and much too large for a phone.

Checked at 393×659, 402×734, 440×782, 874×402 landscape, and 360×640.
Playwright has no iPhone 17 Pro profile, so those brackets straddle it rather
than matching it exactly.

## Question bank

`public/questions.json` is harvested from [OpenTDB](https://opentdb.com)
(CC BY-SA 4.0) and committed, rather than fetched at runtime. Runtime fetching
would put every deployment behind OpenTDB's per-IP rate limit from a shared
Cloudflare egress address, which is a bad trade for content that never changes.

2,270 questions across 24 categories, every one of which (bar Science: Gadgets)
carries at least four questions at each of easy, medium and hard — which is
what makes the ledger's difficulty weighting mean anything.

Questions carry a `speakable` flag computed at load: the free-answer rounds
(speed round and final) skip anything that only makes sense with four options
on screen, and anything whose answer is too long to judge by ear. 1,859
questions qualify.

## Tests

```
npm test              # game rules, headless, no browser needed
npm run test:pointer  # mouse and touch, needs Playwright
```

`test/run.mjs` stubs a minimal DOM, loads the real `public/app.js`, and plays
complete games at 2–4 players and a range of bot accuracies, asserting that
questions never repeat, ledgers always empty, undo walks back to the start, and
the scoring rules match the design doc.

`test/pointer.mjs` drives a game in Chromium using only mouse and touch,
checking that pointer reaches every action, that one tap never commits
anything, and that every touch target clears 32px. It then replays a question
screen at five viewport sizes, asserting no horizontal overflow, that
overflowing content scrolls rather than being clipped, that the control bar
stays on screen, and that question text lands between 16 and 40px. Playwright is deliberately
not a project dependency — it would slow every Cloudflare deploy for a test
that only runs locally — so this exits 0 with a note when it isn't installed:

```
npm i -D playwright && npx playwright install chromium
```

## Deploying

Cloudflare Workers Builds is connected to this repository. Merging to `main`
triggers the build and deploy; `wrangler.toml` is the whole configuration.

One thing to check on the first deploy: `name = "tv-trivia"` in `wrangler.toml`
has to match the Worker the build is attached to. If the existing Worker is
called something else, change that line — otherwise the deploy quietly creates
a second Worker under a different `workers.dev` hostname.

There is nothing else to configure. No D1, no KV, no secrets, no bindings
beyond the static assets directory.
