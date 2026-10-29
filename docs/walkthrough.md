# Understand and demonstrate Fieldline

This guide explains the implemented code. It is not a claim that every requirement has been verified. The README's current status and saved measurements are the record of what actually works.

## The whole system in one minute

Fieldline collects NFL odds from two sportsbooks, turns their different formats into the same structure, and shows comparable prices in one board. Each sportsbook has one collector running on the server. Every viewer shares those results, so opening ten tabs does not create ten sets of sportsbook requests.

Both feeds now use Ontario prices. The server can remain in Ohio: where the server runs and which regional price feed it reads are separate choices. FanDuel's Canadian discovery, prices and push connection are configured together, so a label change cannot silently leave the app reading New Jersey prices. The older measurements in the README record the previous New Jersey configuration explicitly.

Both books supply an initial list of games and prices, then push changes over persistent connections. FanDuel also checks HTTP prices every quarter-second, even while push works: a connected push feed may still be late. Both paths can deliver changes, and polling continues during a push outage. The server pushes board changes to browsers immediately.

The shared data lives in memory. We only need the current board for this prototype, so adding a database would add work without solving a current requirement. A restart fetches the current state again.

## What an odds update means

Suppose a team is offered at **+120** by DraftKings and **+115** by FanDuel. A $100 winning bet would make $120 or $115 profit, respectively. For that same outcome, +120 is the better price.

The comparison changes for spreads. **Team -3 at -110** and **Team -3.5 at +100** have different winning conditions. The app keeps those lines separate. It compares prices only when the game, period, market, side and point line match. Ties show both books.

One source might call a team “CAR Panthers” and the other “Carolina Panthers.” Explicit team aliases give them the same identity. Unknown names are flagged rather than guessed. The app also checks game date, home/away orientation and kickoff differences to avoid merging unrelated events.

## Reading movement and history

The odds-format control changes how a price is written; it does not change which bet or book wins. American −110 is shown as decimal 1.909. The comparison keeps the original precision. The selected source and format are shareable in a URL such as `/?view=fanduel&odds=decimal`.

An upward arrow means a higher payout for the same bet, with the previous price shown beside it. A downward arrow means a lower payout. A move from −120 to −110 is an improvement; −100 and +100 pay the same and get no directional arrow. A changed point line is a separate “line changed” event. Pauses and reopenings are availability events, not better or worse prices. These cues last eight seconds and are also included in accessible button names.

Select a price or **Price history** to see observations collected by this tab. **Recent moves** shows observed transitions. Both are explicitly labeled “since this page opened”: there is no saved sportsbook history before that moment, and reloading clears them. The chart retains up to 60 minutes and 120 observations per selection/book, with a total cap of 512 selection series. Recent moves retain 30 transitions and display the latest eight for the selected source view.

A reconnect or stale source creates a gap. The next available state establishes a new baseline; the app does not claim it saw the changes missed during the gap. Different point lines also start separate chart segments. The other book can continue recording while one source is unavailable. Charts use decimal prices and record receipt by this tab, not the exact time the sportsbook changed its price. These controls add no source polling.

## Why the two collectors are different

A **snapshot** is a full picture of the requested state. A **delta** contains only changes to that picture. DraftKings can send a selection ID and a new price without repeating its game or market. The collector merges the change into existing state instead of replacing the whole selection with an incomplete object.

FanDuel's HTTP price response is a snapshot for a batch of requested markets. Its endpoint silently truncated a request for 87 markets to 80. Splitting requests into groups of at most 70 restores all 87 markets and 174 prices. Requested and returned counts are now checked explicitly. A missing market is removed and flagged; the app does not silently restore an old discovery price.

FanDuel's push feed sends updated market state. Its public connection configuration is read from the site's current JavaScript, and refreshed automatically if rejected. An acknowledgement alone contains no prices, so each reconnect also requires a fresh complete baseline. Updates arriving during a slow HTTP request keep flowing and take precedence over that request's response. A request started after the latest push can advance prices immediately, because HTTP may lead the push feed. The source timestamps are not precise enough to guarantee perfect ordering between every push and HTTP snapshot; that limitation is explicit.

A **WebSocket** is a persistent two-way connection. Both bookmakers use it to push changes. **Server-sent events (SSE)** are a simpler persistent server-to-browser stream. Our board uses SSE because viewers mostly receive updates. Browsers reconnect automatically and receive a fresh full board before subsequent changes.

## What happens when something breaks

Each source has its own state and retry cycle. A failing DraftKings collector cannot stop FanDuel. FanDuel can continue through a push failure using polling, or through a short polling failure using verified push. Its full-board verification expires after 30 seconds without a complete HTTP response, even if the socket still answers. When no sufficiently fresh path remains, the source becomes stale. Stale or suspended offers cannot win Best Price; previously known stale prices may remain visible with a clear label.

Retries grow farther apart after repeated failures, with a small random variation to avoid synchronized bursts. HTTP errors that include Retry-After also feed that instruction into the retry delay. The DraftKings handshake/snapshot error is preserved when the socket subsequently closes, so the useful cause remains visible.

The hosted access issue is a real example: Render initially subscribed to DraftKings' stream but received HTTP 403 for the starting snapshot. A working stream alone was insufficient, because partial updates need an initial state. Moving to Fly in Toronto did not solve it. On Render, switching the snapshot request to a browser-compatible network client did: both sources now populate the public board. That client is a small Python helper; the app and continuous stream remain in Node. It starts a fresh anonymous session each time, so there is no copied login cookie that you must renew by hand. Errors still become stale states and use the same retry policy.

Snapshots can take longer than individual stream changes. During a periodic snapshot refresh, the app now keeps processing changes against its current board while saving those changes for the replacement snapshot too. That prevents the background refresh from freezing current prices. A test deliberately holds the refresh open and verifies that a price change is still delivered immediately.

## How to talk about speed accurately

There are different intervals:

1. The sportsbook changes a price, then makes it available in its feed.
2. Our collector receives it and updates the shared board.
3. The update travels to the browser and appears on screen.

We can time our requests and processing. For changed games in view, the browser estimates rendering time after two animation frames and corrects for its clock difference from the server. That estimate is not a physical screen measurement.

DraftKings provides feed timestamps, but they do not prove the exact time its trading system changed the price. FanDuel's push timestamp has only whole-second precision, so a reported age can include almost a second of rounding. Its HTTP response has no change timestamp. Push avoids an intentional polling wait; the parallel quarter-second HTTP checks add roughly zero to a quarter-second of polling wait when they are the first path to expose a change, under normal operation. Those are design properties, not measured end-to-end guarantees.

The saved local test captured two DraftKings changed-price rendering samples, approximately 58–61 ms after backend receipt. The first working cloud observation also received real DraftKings price changes, but its remote CLI clock was not synchronized and produced invalid negative delivery times. That exposed a measurement problem; the benchmark now calibrates its clock first. Do not reuse those invalid numbers as a speed claim. Neither source has been measured during an actual NFL game yet. Use the exact sample counts and limitations from the README.

The corrected cloud observation captured two more DraftKings changes at approximately 70–73 ms from backend receipt to the remote command-line observer, with at least ±25 ms clock uncertainty. This verifies the live delivery path, but it is still only two pregame samples and does not time browser rendering. FanDuel stayed healthy without a price change during that short window, so its change-delivery row remains unmeasured.

At 8:06 p.m. Toronto time on October 28, the earlier New Jersey FanDuel configuration also delivered actual changes for Atlanta at Tampa Bay. HTTP caught a total-line change first; push caught the subsequent moneyline change first. Processing in our store took about 1.17 and 1.75 ms respectively. This is why we keep both paths active. These two correlated messages prove actual price delivery through the public stream; they do not establish a broad latency distribution, browser-paint timing, or live-game performance.

After the Ontario migration, independent checks matched all 174 FanDuel quotes and all 174 DraftKings quotes against fresh official Ontario responses, and the complete test suite passed 65 tests. The public board showed 29 matched games and 348 prices. A 330-second Ontario observation received two DraftKings changed-price messages in about 28–31 ms after backend receipt, with at least ±29 ms clock uncertainty. No FanDuel changed-price message was observed during that window, so its Ontario change-delivery time remains unmeasured. An acknowledged Ontario push connection proves subscription setup, not delivery speed. Use these current results and keep the older New Jersey measurements clearly identified.

A later [Ontario observation](measurements/render-ontario-first-push.json), at 10:21–10:26 p.m. Toronto time on October 28, did receive actual FanDuel price pushes through the public stream: Green Bay's moneyline moved from −190 to −200 and Carolina's from +160 to +168. Store processing took about 2.12 and 4.82 ms. This proves the Ontario push path delivered changed prices; it does not measure bookmaker-to-screen latency. The two updates were on one pregame game, before the quarter-second polling change. The current local test suite now passes 86 tests, including scheduling, presentation, source gaps and reconnect-history cases; the 65-test migration result is historical.

## Demo sequence

1. Run `npm ci` and `npm start`, then open `http://localhost:3210`.
2. Check both source indicators before comparing prices. Open Best Price, DraftKings and FanDuel in turn.
3. Find a game present at both books. Compare moneyline, spread and total rows. Explain why different point lines are separate.
4. Switch between American and decimal odds. Copy the resulting URL to show that source and format are shareable.
5. Select a price to open its history, and open Recent moves. Explain the tab-local baseline and why there may be only one observation or no moves yet. Do not present a fixture replay as a real sportsbook change.
6. Open a second tab. Both tabs share the server's collectors and receive pushed updates; each tab starts its own observation history.
7. Open `/api/metrics` to show source health and sample counts. A zero live sample count means “not measured.”
8. Show the public Render page with both sources connected. Explain the snapshot transport fix, the free host's sleep limitation, and the distinction between verified pregame data and still-outstanding in-game measurements.

For the remaining live-game check, observe both source pages and the board during an actual NFL game. Verify live status, suspensions and reopenings, changed prices, and changed lines. Save the measurement report with its environment, observation window and sample counts. A fixture replay can test logic but cannot replace this observation.

## Questions to answer in your own words

- Why do we fetch once per sportsbook rather than once per viewer?
- Why can a price-only DraftKings message not replace the whole selection?
- Why are -3 and -3.5 separate comparisons?
- What does a healthy connection tell us, and what does it not tell us about an unchanged quote?
- Why does a fast FanDuel request not prove how quickly a changed price reaches us?
- What evidence would establish live-game performance?
- Why does this prototype use memory instead of a database?
- If we ran three web servers, how would we avoid starting three collectors per book?

For the final question: separate ingestion from serving, keep one owner per source, and distribute updates to the web servers through a shared message service. That is a next step, not functionality claimed by this version.

Codex assisted with implementation and documentation. Review the code, run the demo and explain these choices yourself before submitting.
