# Remote Trivia — build status

## Done — the whole loop plays end to end

- [x] Cloudflare Worker + static assets, no bindings to configure
- [x] Attract screen and D-pad setup (2–4 players, on-screen keyboard for names)
- [x] Category draft with one veto per player, pool sized `questions + players`
- [x] Section 1 (easy, ledger 1–4) and Section 2 (hard, ledger 2–6), turn
      order reversed, with the speed round (medium) between them
- [x] Wager ledger — each value spent exactly once, chosen before any reveal
- [x] Difficulty per round rather than per wager
- [x] Paced reveal A→B→C→D, arrow to lock at any point
- [x] Early lock bonus (+1 before option D)
- [x] Roll again on correct, sweep bonus (+3) for an unbroken ledger
- [x] Steal by the next player, flat 1 in Section 1 and 2 in Section 2, with
      the correct answer withheld until the steal is settled
- [x] A miss opens the rest of the board before the steal, so guessing early
      never shrinks what the next player gets to choose from
- [x] The stealer keeps their own turn whatever the steal does
- [x] Speed round — per-player clock, free answer, host judges, comeback weighting
- [x] Final — dynamic wager cap, lowest scorer declares first, wagers resolve
- [x] Sudden death for ties
- [x] Back undoes anything, including a misjudgment
- [x] Mouse and touch as a secondary input, with the hint bar doubling as the
      touch control bar and a two-tap select-then-commit on every target
- [x] Names typed into a real text field, so the TV's own keyboard does the work
- [x] Layout that adapts on phones: an app shell with its own scrolling content
      region, safe-area insets, and a control bar that cannot overlap content
- [x] A web app manifest, so an installed copy runs standalone by declaration
      rather than by whatever the platform assumes
- [x] Answer options two-up when the phone is held sideways
- [x] Type that shrinks to the space actually available, measured per render
- [x] No repeated questions within a session
- [x] Free-answer filter for the speed round and final
- [x] Headless test harness that plays full games and asserts the rules

## Next — needs a playtest before it's worth building

- [ ] **Speed round length.** Currently 45s. The doc flags 45 vs 60 as an open
      question; both are one constant in `TUNING`.
- [ ] **Speed round question count.** Check whether 45s actually yields enough
      questions to feel like a round.
- [ ] **Sweep bonus reachability.** Five correct in a row in Section 2 is now
      five *hard* questions in a row, so +3 may never fire. Section 1's sweep,
      four easy in a row, may conversely be near-automatic. Worth watching
      whether the bonus wants to differ by section.
- [ ] **Wager stakes.** With difficulty fixed per section, betting high carries
      no extra risk — the ledger is now an allocation puzzle rather than a
      gamble. That is the deliberate tradeoff for sections whose scores compare
      cleanly; worth confirming it still feels like a decision at the table.
- [ ] **Steal frequency in Section 2.** All-hard questions mean more misses,
      so more steals. At a flat 2 points those may add up faster than expected.
- [ ] **Wager cap.** `max(15, gap+1)` makes the final swingy by design. Confirm
      it doesn't make Sections 1 and 2 feel pointless.

## Open questions

- **A correct early lock still leaves options hidden.** Only a miss opens the
  board, since only a miss leads to a steal. Players may want to see what the
  other options were either way; it costs a beat to show them.

## Later

- [ ] **Handicaps.** Design doc has the full ladder. Difficulty shift is the
      cleanest lever and is one line in `DIFFICULTY_FOR_VALUE`.
- [ ] **Bigger question bank.** 2,270 questions across 24 OpenTDB categories,
      1,859 of them usable in the free-answer rounds. A four-player game uses
      roughly 100, so repeat play will start recycling categories long before
      it recycles questions. Options: harvest more sources, or write house
      questions.
- [ ] **D1.** Only worth it if the bank outgrows a static file or the game
      needs to remember anything between sessions. It currently needs neither,
      and adding it means dashboard configuration.
- [ ] **Resume after a reload.** A refresh mid-game currently loses everything.
      `localStorage` would cover it.
- [ ] **Wager secrecy for the final.** Currently open wagers, lowest declares
      first. A host-enters-while-others-look-away mode is the alternative.
- [ ] **Sound.** A reveal tick and a lock sting would carry a lot of the pacing.

## Known rough edges

- The palette is defined with CSS custom properties, which need Chromium 49+.
  On an engine older than that the game would run but render unstyled. Nothing
  has reported it; giving every `var()` a literal fallback is the fix if it
  turns up.

- On the smallest screens (360×640) with an unusually long question, the last
  option needs a short scroll inside the content region. It is reachable and
  cannot be hidden behind the control bar, but it does not all fit at once.

- The judge screen drops the score strip when it is showing a question, because
  the two together overflow a 1080p screen. Scores are one press away on the
  next wager screen.

- Whether a TV browser raises its keyboard on focus alone, or waits for OK on
  the field, varies by platform and could not be tested here. Down advances
  either way, so the field is never a dead end, but the flow is worth watching
  on the actual set.
- Names default to Player 1–4 if left blank, which is one press per player.
- The final wager is adjusted by ±1 / ±5 chips rather than a numeric keypad.
  Fine by remote, a little slow by touch for a wager of 30-something.
- The speed round has one level of undo (Back takes back the last mark),
  not the full undo stack the rest of the game has, because the clock is running.
- Sudden death awards a single point to break the tie rather than tracking a
  separate tiebreak column.
