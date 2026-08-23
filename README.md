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

## Playing

Open the deployed URL in the TV browser. Everything maps to the D-pad:

| Input | Meaning |
|---|---|
| OK / Enter | Advance, reveal, confirm, lock |
| Left / Right | Move between options or wager values |
| Up / Down | Secondary selection |
| Back | Undo the last action, including a misjudgment |

Every screen prints its own key map along the bottom, so nobody has to
remember any of this. Tapping the screen counts as OK, which makes the game
testable on a phone.

Coloured remote buttons are deliberately unused: their key codes vary wildly
across Tizen, webOS, Fire TV and Android TV.

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
node test/run.mjs
```

Stubs a minimal DOM, loads the real `public/app.js`, and plays complete games
at a range of bot accuracies, asserting that questions never repeat, ledgers
always empty, undo walks back to the start, and the scoring rules match the
design doc.

## Deploying

Cloudflare Workers Builds is connected to this repository. Merging to `main`
triggers the build and deploy; `wrangler.toml` is the whole configuration.

One thing to check on the first deploy: `name = "tv-trivia"` in `wrangler.toml`
has to match the Worker the build is attached to. If the existing Worker is
called something else, change that line — otherwise the deploy quietly creates
a second Worker under a different `workers.dev` hostname.

There is nothing else to configure. No D1, no KV, no secrets, no bindings
beyond the static assets directory.
