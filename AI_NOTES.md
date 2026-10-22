# AI notes

**Tools.** Claude Code (Anthropic, model Claude Opus 5.5) as a coding agent in my terminal, with access to this folder and a local Docker. It wrote most of the code, the tests and the first drafts of these notes. I set the scope, made the decisions on the open questions, and checked the results by running the tests and the app.

**A prompt that worked well.** I pasted the whole brief and asked for it to be built in a new folder, keeping the code simple enough that I could explain every line and change it live on a call. Asking for "explainable" up front kept it to plain Express + `pg` with SQL I can read, instead of an ORM and extra layers.

**Things the AI got wrong, and how they were caught.**

1. *The countdown number was computed from two different clocks.* The first version set `expires_at` with the database's `now()` but computed `expiresInSeconds` in Node with `Date.now()`. A test expecting at most 2 seconds left on a 2-second hold got 3. Comparing the clocks showed the database container was 67 ms ahead of Node, enough for `Math.ceil` to round up. That is exactly the "two clocks disagree" problem the brief warns about for the screen, just on the server side. Fixed by computing the remaining time in SQL from the same clock (`expires_at - clock_timestamp()`).
2. *Async errors in Express 4.* The first draft used Express 4, whose route handlers don't pass a rejected promise to the error middleware: a thrown "insufficient stock" would have become an unhandled rejection and a hung request instead of a 409. Caught on review before running it; switched to Express 5, which handles async errors.

I reviewed the locking and webhook logic, ran the tests and the full flow myself, and chose the late-payment rule.
