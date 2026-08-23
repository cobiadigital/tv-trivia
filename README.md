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

## Old television engines

`public/app.js` is written to an ES5-era baseline: no arrow functions, no
`const`/`let`, no template literals, no `fetch`. A webOS set can be running an
engine as old as Chromium 38, and `npm test` scans the file for anything past
that baseline — this is cheap insurance, because the failures are invisible.
`fetch` sat at the top of a promise chain, so on an engine without it the call
threw *before any promise existed*, nothing caught it, and the screen simply
read "Loading questions" for ever.

The question bank is loaded over `XMLHttpRequest` with a 30-second timeout, and
every failure path lands on an error screen that names the cause and prints the
user agent. A `window.onerror` handler paints anything else that gets thrown.
There is no console on a television, so if the app cannot say what went wrong,
nobody can find out.

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

### Number keys

Every screen with a list on it also takes a number as a direct shortcut:

| Screen | Number |
|---|---|
| Player count | 2, 3 or 4 picks it outright |
| Category draft | vetoes the *n*th category |
| Wager | the number **is** the wager — press 3 to bet 3 |
| Question | 1–4 locks A–D, ignored for options not yet revealed |
| Steal | 1–4 steals that option |
| Final wager | digits type the number, so 23 is two presses; 0 clears |
| Sudden death | picks the winner |

A number commits immediately rather than selecting first. Unlike a stray tap or
a nudged pointer, pressing 3 is unambiguous — and Back undoes it.

This exists because of the **LG Magic Remote**, whose D-pad drives an on-screen
pointer rather than sending arrow keys: webOS consumes the arrows before the
page sees them. Pointing and clicking works (see *Mouse and touch*), but if the
number buttons reach the page they are the faster way to play, and on a remote
whose arrows never arrive they may be the only keys that do.

Whether a given set delivers digits to page content is not something this
repository can answer. The title screen shows the last key the page actually
received, blank until something arrives — press a button and it either names the
key and its code or it does not appear at all. There is no console on a
television, so the screen has to answer the question itself.

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
- The layout is an **app shell**: the page itself never scrolls, a content
  region inside it does, and the control bar is an ordinary flex sibling below
  that region. Nothing is `position: fixed` and no height is measured in script,
  so the bar cannot be painted over the content and there is no reserve to go
  stale. `layoutShell()` in `app.js` moves everything ahead of the hint bar into
  `.screen-scroll` after each render, which keeps the view cases free of layout
  scaffolding.

  Two earlier attempts got this wrong in the same way. A *sticky* bar keeps its
  place in the flow at the end of the content while painting itself pinned to
  the bottom, so it covered whatever it scrolled past. Replacing it with a
  *fixed* bar plus a script-measured reserve fixed that in the browser but not
  in a standalone PWA window, where a fixed bar above a body-scrolled page and a
  measured height that has to survive rotation are all things that behave
  differently. The shell depends on none of them.
- Type and spacing step down, and categories go full width — they're too long
  to sit two-up, and full width makes them the easiest thing to hit.
- **Held sideways, answer options go two-up.** A landscape phone is about 400px
  tall and 870px wide: in one column the last option fell below the fold and the
  one above it landed under the control bar, so half the board was untappable
  without discovering that the page scrolls. Two columns fit the whole thing.
- After each render, `shrinkToFit` measures whether the question screen actually
  fits and steps the type scale down until it does. Question and option lengths
  vary too much, across too many viewports, for a fixed budget to hold.
- Those steps are coarse and bottom out after three of them, so `fitToScreen`
  then scales continuously: everything is sized in `rem`, so scaling the root
  font size scales the layout with it, and a couple of measured passes land on
  the largest size that still fits. Floored at 0.62 of base, below which
  scrolling comes back — a viewport that short is beyond saving.
- The control bar is **excluded** from that shrinking. It is sized in `px`, with
  44px chips, because it is the thing you have to hit to use the game: shrinking
  the board to fit must never shrink the controls out from under a thumb. Answer
  options carry a 34px floor for the same reason.
- Televisions are left alone. Their type is sized to be read from a sofa, and
  the density steps plus the fit test already guarantee a whole screen, so
  `fitToScreen` returns early unless the phone shell is active.

The root font size is fixed on phones rather than scaled to viewport height:
`2.2vh` is right for a panel and much too large for a phone.

Checked at 393×659, 402×734, 440×782, 360×640 and their landscape rotations,
each asserting the whole board fits with nothing left below the fold.
Playwright has no iPhone 17 Pro profile, so those brackets straddle it rather
than matching it exactly.

The touch guarantee is deliberately in two parts. Anything drawn clear of the
control bar must answer a tap **where it sits** — checked with raw-coordinate
taps, because Playwright's `.tap()` scrolls the target into view first and would
paper over exactly this bug. Anything the bar overlaps must still be reachable
by scrolling: on the smallest screens the longest questions genuinely do not
fit, and scrolling to them is ordinary, but silently swallowing a tap is not.

## Installed to a home screen

`manifest.webmanifest` asks for a standalone window in any orientation, and
`index.html` carries the `apple-mobile-web-app-*` tags iOS wants. Before that
there was no manifest at all, so iOS decided for itself what "add to home
screen" meant — which is no basis for reasoning about a layout bug that only
shows up there.

The status bar is `black-translucent`, so the page runs edge to edge and the
safe-area insets in `style.css` are what keep content clear of the Dynamic
Island and the home bar.

Icons are generated by a script rather than drawn: a rounded-rect focus ring in
the accent colour, which is the motif the whole interface is built on.

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

## Version

The version shows in small type at the top right of the title screen — on the
loading and error states too, which is when it is most worth being able to read
it off a television.

It lives in two places, `VERSION` in `public/app.js` and `version` in
`package.json`, because nothing at runtime can read `package.json` to derive it.
`npm test` fails if the two drift apart. Bump both together, and match the
number to the pull request it ships in, so a screen photographed off a
television identifies exactly what is running.

## Deploying

Cloudflare Workers Builds is connected to this repository. Merging to `main`
triggers the build and deploy; `wrangler.toml` is the whole configuration.

One thing to check on the first deploy: `name = "tv-trivia"` in `wrangler.toml`
has to match the Worker the build is attached to. If the existing Worker is
called something else, change that line — otherwise the deploy quietly creates
a second Worker under a different `workers.dev` hostname.

There is nothing else to configure. No D1, no KV, no secrets, no bindings
beyond the static assets directory.
