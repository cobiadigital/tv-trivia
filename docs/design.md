# Remote Trivia — Game Design

A TV-browser trivia game driven entirely by one remote. No pairing, no second
screens, no typing. The remote passes to whoever is hosting the current question.

---

## Players and roles

- 2 to 4 players or teams (soft cap; nothing in the rules breaks at 6)
- One **host** at a time, holding the remote
- The host is whoever answered the previous question. They operate the screen
  and read aloud, then hand the remote to the next player when their turn comes

The host never needs secret knowledge. In the multiple-choice sections the app
judges automatically. In the free-answer sections the answer is revealed on
screen *after* the player has spoken, and the host just presses Correct or Wrong.

---

## Structure

| Round | Questions | Difficulty | Format | Wager pool |
|---|---|---|---|---|
| Section 1 | 4 per player | Easy | Multiple choice, paced reveal | 1, 2, 3, 4 |
| Speed Round | as many as fit | Medium | Free answer, timed | flat 1 each |
| Section 2 | 5 per player | Hard | Multiple choice, paced reveal | 2, 3, 4, 5, 6 |
| Final Question | 1 | Medium | Free answer | 0 to cap |

The speed round sits between the two sections rather than after them. It
breaks up the two long multiple-choice stretches, and its comeback weighting
lands at the halfway mark where it can still change the game.

Turn order **reverses** between Section 1 and Section 2. Going last is a small
edge, since you have watched three players burn questions first, and flipping
the order costs nothing to implement.

Roughly 25 to 35 minutes for four players.

---

## Category draft and veto

At the start of each section the app draws a pool of categories, sized as
**questions + player count**. Section 1 with four players draws 8 categories,
Section 2 draws 9.

Going around in turn order, each player vetoes exactly one category. What
survives is the section's category list, which then stays on screen for the
whole section.

The veto turns the category preview from information into a decision, and it
lets a table kill the category nobody wants without house-ruling it.

---

## Wager ledger

Each player holds a ledger of point values and spends each value exactly once
per section.

- Section 1 ledger: 1, 2, 3, 4
- Section 2 ledger: 2, 3, 4, 5, 6

On your turn you see the category, then choose which unspent value to put on it
**before any options are revealed**. Correct, you bank that value. Wrong, the
value is burned and scores nothing.

This is the whole strategy layer: save your 6 for a category you own, dump your
2 on the one you dread. Every value has to go somewhere, so a category you know
nothing about is where the small numbers get spent. It also means every player answers the same number of
questions per section, so no one gets shorted.

The section ends when every player's ledger is empty.

---

## Difficulty by round

Difficulty is a property of the round, not of the wager. OpenTDB tags every
question easy, medium, or hard, so this is a filter on the pull, not new content.

| Round | Difficulty |
|---|---|
| Section 1 | easy |
| Speed Round | medium |
| Section 2 | hard |
| Final, sudden death | medium |

The game ramps rather than stepping, and every player in a section faces the
same difficulty as everyone else, so a section's scores are directly comparable.

The wager is then purely an allocation problem: you have to spend 1, 2, 3, 4
across four categories, so the decision is which category deserves your 4 and
which one only gets the 1. There is no risk premium for betting high, which is
the tradeoff for making the sections legible.

---

## Paced reveal

The question appears alone. The host reads it aloud, then presses OK to reveal
option A. Presses again for B, then C, then D.

At any point the player up can call an answer. The host arrows to that option
and presses OK to lock it. The screen then reveals correct or incorrect.

**Early lock bonus:** locking before the fourth option is revealed adds +1.
Calling it off two options is a real gamble, since D might have been the answer
you wanted. This is the mechanic that makes the reveal pacing matter rather than
just being ceremony.

Getting it wrong early costs nothing extra beyond the burned wager: the rest of
the options are then revealed for the steal, so guessing early never shrinks the
board the next player sees.

---

## Roll again

A correct answer keeps the spotlight. You immediately take another question,
spending another value from your ledger.

**Sweep bonus:** clear your entire ledger in a single unbroken run and take +3.
That is four correct in a row in Section 1, five in Section 2.

A wrong answer ends your run and passes the turn.

---

## Steal

When a player misses, the **next player in turn order** gets one shot at the
same question, with the remaining options still on screen.

- A steal is worth a flat **1 point in Section 1, 2 points in Section 2**,
  regardless of what the player who missed had wagered
- The stealer spends nothing from their own ledger
- Only one steal attempt per question, and a failed steal costs nothing
- **The stealer keeps their own turn.** Winning, missing or passing a steal
  does not consume it: once the steal resolves, play moves to the next player
  in order, who is the stealer. A steal is a free extra shot, never a trade
  against your own question

**A miss opens the rest of the board.** If the player guessed before all four
options were shown, the unrevealed ones go up before the steal is offered.
Otherwise the next player would be picking from one or two options — and the
answer might not even be among them, making the steal impossible rather than
merely hard.

**The correct answer stays hidden until the steal is settled.** A miss shows
only that it was a miss, with the wrong answer marked. Revealing the answer
first would hand the steal to the next player, which is no steal at all. The
answer goes up once the steal is taken, missed, or passed — and on a miss where
no steal is possible at all.

Steals are the reason the other three players stay awake while someone else is
up. Without it, everyone is idle 75% of the time.

---

## Speed Round

Each player or team gets their own timer and their own question set.

1. Timer starts
2. Question appears, free answer, no options shown
3. Player shouts an answer
4. Host presses OK to reveal the correct answer, then Right or Wrong
5. Advances immediately to the next question
6. Repeat until the clock runs out

One point per correct. No penalty for a miss, so the right strategy is to guess
fast and move on. Tally shown at the end of each player's run.

**Comeback weighting:** give trailing players a longer clock, scaled to the gap.
Something like +5 seconds per 10 points behind the leader, capped. This is the
main anti-blowout lever and it is invisible enough that it does not feel like
charity.

**Open tuning question:** at 15 seconds this is two or three questions, which is
more of a hiccup than a round. 45 to 60 seconds gives it real shape. Worth
playtesting both.

**Content caveat:** OpenTDB questions are written to be answered with four
options in front of you. Plenty of them read as nonsense without options
("Which of these was NOT a..."). Filter the pool for the speed round and final:
drop anything matching *which of the following*, *of these*, *NOT*, *all of the
above*, and drop true/false entirely. Prefer short `correct_answer` strings,
under about three words, so verbal judging is unambiguous.

---

## Final Question

1. The category is announced
2. Every player locks a wager, from 0 up to their cap
3. The question appears, free answer
4. Thinking time, roughly 30 seconds
5. Each player says their answer aloud in turn
6. The correct answer is revealed
7. The host marks each player Right or Wrong, and wagers resolve

Wrong answers lose the wager. This can swing the whole game, which is the point.

**Wager cap:** `max(15, gap_to_leader + 1)`, floored at 5 for everyone. The
floor keeps a zero-score player in the game. The dynamic ceiling guarantees that
whoever is trailing can always mathematically catch the leader, which is the
single most important fix for a game that is otherwise decided by the halfway
point.

**Wager secrecy:** on one shared screen, hidden wagers are awkward. Three
options: paper and pencil, or the host enters each wager while the others look
away, or accept open wagers with the lowest scorer declaring first, which is how
tournament Jeopardy handles it and is a decent mechanic in its own right.

---

## Sudden death

Ties after the final go to one free-answer question. First correct answer wins,
host judging, repeat until broken.

---

## Future: handicaps

Trivia between a nine-year-old and their uncle is not a game, it is a lecture.
A golf-style handicap per player or team fixes that, and the turn-based
structure makes it nearly free to add, because **each player is already
answering their own question**.

A handicap is an integer offset per player, set at Setup. Several levers, in
rough order of how well they work:

1. **Difficulty shift.** Offset the round's difficulty per player. A kid at +1
   sees medium in Section 2 where an adult sees hard, and easy in the speed
   round. This is the cleanest lever, but OpenTDB has only three tiers, so it is
   coarse and saturates quickly.
2. **Category pool split.** Draw the kid's questions from kid-friendly
   categories (Cartoon & Animation, Video Games, Animals) while adults draw from
   the full pool. Categories are already per-question, so nothing structural
   changes.
3. **Reveal generosity.** A handicapped player sees all four options at once;
   a scratch player must lock by option C or lose the early-lock bonus. Costs
   one conditional in the reveal state.
4. **Speed round clock.** Straight time multiplier. Stacks cleanly with the
   comeback weighting already in the round.
5. **Score multiplier.** Simplest to build, worst to play. It tells the kid
   outright that their points are fake. Use only as a last resort.

Two places the handicap does not apply cleanly, worth deciding before building:

- **Steals.** The stealer inherits a question drawn for someone else's tier. Two
  fixes: bar steals across mismatched tiers, or let the steal stand as-is on the
  reasoning that a stolen question is a bonus either way. The second is simpler
  and probably fine. (Less of a problem now that difficulty is per-round: within
  a section every question is the same tier anyway.)
- **The final.** Everyone answers the same question, so a difficulty shift is
  impossible. Handicap it on the wager cap instead: raise the floor for
  handicapped players so a kid can bet meaningfully without having banked much.

Ship without any of this. Add it once the core loop is fun, because a handicap
system tuned against a game you have not playtested is guesswork.

---

## Screen states

```
ATTRACT ──▶ SETUP (players, names, handicaps)
              │
              ▼
        CATEGORY_DRAFT (pool shown, each player vetoes one)
              │
              ▼
        SECTION_INTRO (surviving categories, ledgers)
              │
              ▼
        WAGER_SELECT ──▶ QUESTION ──▶ REVEAL_A ──▶ REVEAL_B
              ▲                                        │
              │                                        ▼
              │                                    REVEAL_C ──▶ REVEAL_D
              │                                        │            │
              │                                        ▼            ▼
              │                                     LOCK_ANSWER ◀───┘
              │                                        │
              │                                        ▼
              │                                     JUDGE
              │                              ┌─────────┴─────────┐
              │                          correct               wrong
              │                       (answer shown)   (board opened, but
              │                              │          answer withheld)
              │                              │                   │
              └──── roll again ◀─────────────┘                   ▼
                                                             STEAL_OFFER
                                                                 │
                                                                 ▼
                                                        REVEAL_ANSWER
                                                                 │
                                                                 ▼
                                                   NEXT_PLAYER (the stealer,
                                                    whatever the steal did)
                                                                 │
              (ledgers empty) ───────────────────────────────────┘
                              │
                              ▼
                        SPEED_ROUND (per player, comeback clock)
                              │
                              ▼
                        SECTION_2 (same loop, hard, turn order reversed)
                              │
                              ▼
                        FINAL_WAGER ──▶ FINAL_QUESTION ──▶ FINAL_JUDGE
                              │
                              ▼
                        SCOREBOARD ──▶ SUDDEN_DEATH (if tied)
```

---

## Remote input contract

Every state maps to at most five inputs.

| Input | Meaning |
|---|---|
| OK / Enter | Advance, reveal, confirm, lock |
| Left / Right | Move between options or wager values |
| Up / Down | Secondary selection where needed |
| Back | Undo last action, correct a misjudge |

Notes for the build:

- Do not use colored buttons. Their key codes vary wildly across Tizen, webOS,
  Fire TV, and Android TV browsers
- Arrow keys and Enter map to the D-pad on essentially every TV browser, so
  standard `keydown` handling is enough
- Never rely on hover, and always render an explicit, high-contrast focus ring
- Keep everything inside a 5% safe margin for overscan
- Minimum body type around 32px at 1080p; question text much larger
- **Back must undo a judgment.** The host will misfire. A game with no undo gets
  abandoned mid-round

---

## Scoring summary

| Event | Points |
|---|---|
| Correct answer | wagered value |
| Early lock (before option D) | +1 |
| Sweep a full ledger unbroken | +3 |
| Successful steal | +1 in Section 1, +2 in Section 2 |
| Speed round correct | +1 each |
| Final correct | + wager |
| Final wrong | − wager |
