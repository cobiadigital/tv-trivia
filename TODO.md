# Remote Trivia — build status

## Done — the whole loop plays end to end

- [x] Cloudflare Worker + static assets, no bindings to configure
- [x] Attract screen and D-pad setup (2–4 players, on-screen keyboard for names)
- [x] Category draft with one veto per player, pool sized `questions + players`
- [x] Section 1 (ledger 1–4) and Section 2 (ledger 2–6), turn order reversed
- [x] Wager ledger — each value spent exactly once, chosen before any reveal
- [x] Difficulty weighting — wagered value picks the OpenTDB tier
- [x] Paced reveal A→B→C→D, arrow to lock at any point
- [x] Early lock bonus (+1 before option D)
- [x] Roll again on correct, sweep bonus (+3) for an unbroken ledger
- [x] Steal by the next player, worth half the burned value rounded up
- [x] Speed round — per-player clock, free answer, host judges, comeback weighting
- [x] Final — dynamic wager cap, lowest scorer declares first, wagers resolve
- [x] Sudden death for ties
- [x] Back undoes anything, including a misjudgment
- [x] No repeated questions within a session
- [x] Free-answer filter for the speed round and final
- [x] Headless test harness that plays full games and asserts the rules

## Next — needs a playtest before it's worth building

- [ ] **Speed round length.** Currently 45s. The doc flags 45 vs 60 as an open
      question; both are one constant in `TUNING`.
- [ ] **Speed round question count.** Check whether 45s actually yields enough
      questions to feel like a round.
- [ ] **Sweep bonus reachability.** Five correct in a row in Section 2 may be
      rare enough that +3 never fires.
- [ ] **Wager cap.** `max(15, gap+1)` makes the final swingy by design. Confirm
      it doesn't make Sections 1 and 2 feel pointless.

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

- Setup name entry is a D-pad keyboard grid. It works, but it is the slowest
  part of the game; defaults (Player 1–4) are one press away via DONE.
- The speed round has one level of undo (Back takes back the last mark),
  not the full undo stack the rest of the game has, because the clock is running.
- Sudden death awards a single point to break the tie rather than tracking a
  separate tiebreak column.
