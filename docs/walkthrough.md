# Understand and demonstrate Fieldline

This guide explains current release **`4deb501`**, with **223 automated tests passed and none skipped** in the [test report](measurements/extras-persistent-test-results-20261029.json). The [deployment check](measurements/extras-persistent-deployment-20261029.json) verified nine assets, 29 matched games and 348 main prices. Independent checks matched all [174 DraftKings prices](measurements/extras-persistent-draftkings-main-20261029.json) and [174 FanDuel prices](measurements/extras-persistent-fanduel-main-20261029.json), both on the first attempt.

The [latest extra-market verification](measurements/extras-persistent-independent-20261029.json) checked **2,420 quoted outcomes** across two games, both books and all seven supported kinds per book/game: **zero mismatches on the first attempt**. These are bounded accuracy checks, not proof of permanent correctness or update speed. Public desktop controls were last checked on `b14c22f`; the 375px board check belongs to `8f0148c`, whose CSS is unchanged in the later releases. This does not mean every mobile control or browser was retested. The [latest performance check](measurements/extras-persistent-cloud-comparison-stable-20261029.json) completed two stable windows but was interrupted in its final control window; its limits are explained below. Earlier reports retain their original versions and limitations.

## The whole system in one minute

Fieldline collects NFL odds from two sportsbooks, turns their different formats into the same structure, and shows comparable prices in one board. Each sportsbook has one collector running on the server. Every viewer shares those results, so opening ten tabs does not create ten sets of sportsbook requests.

Both feeds now use Ontario prices. The server can remain in Ohio: where the server runs and which regional price feed it reads are separate choices. FanDuel's Canadian discovery, prices and push connection are configured together, so a label change cannot silently leave the app reading New Jersey prices. The older measurements in the README record the previous New Jersey configuration explicitly.

Both books supply an initial list of games and prices, then push changes over persistent connections. FanDuel also checks HTTP prices every quarter-second, even while push works: a connected push feed may still be late. Both paths can deliver changes, and polling continues during a push outage. The server pushes board changes to browsers immediately.

The current board lives in memory and is fetched afresh after a restart. A separate, optional PostgreSQL database preserves observed price history. Restoring old history never makes an old price live or changes a source's health.

## What an odds update means

Suppose a team is offered at **+120** by DraftKings and **+115** by FanDuel. A $100 winning bet would make $120 or $115 profit, respectively. For that same outcome, +120 is the better price.

The comparison changes for spreads. **Team -3 at -110** and **Team -3.5 at +100** have different winning conditions. The app keeps those lines separate. It compares prices only when the game, period, market, side and point line match. Ties show both books.

One source might call a team “CAR Panthers” and the other “Carolina Panthers.” Explicit team aliases give them the same identity. Unknown names are flagged rather than guessed. The app also checks game date, home/away orientation and kickoff differences to avoid merging unrelated events.

## Reading movement and history

The odds-format control changes how a price is written; it does not change which bet or book wins. American −110 is shown as decimal 1.909. The comparison keeps the original precision. The selected source and format are shareable in a URL such as `/?view=fanduel&odds=decimal`.

An upward arrow means a higher payout for the same bet, with the previous price shown beside it. A downward arrow means a lower payout. A move from −120 to −110 is an improvement; −100 and +100 pay the same and get no directional arrow. A changed point line is a separate “line changed” event. Pauses and reopenings are availability events, not better or worse prices. These cues last eight seconds and are also included in accessible button names.

Select a price or **Price history** to see actual server observations from up to **48 hours**. Retention is bounded to 3,000 points per book/game/market/side, 1,024 series and 150,000 points in total, so a busy series or a new deployment may show less. There is no invented history before collection started. The chart may temporarily show a labeled current-tab view while saved observations load. **Recent moves** is still tab-local: it retains 30 observed transitions, displays the latest eight for the selected source view, and resets when the page reloads.

Source outages, stale periods, suspension, removal and changed point lines create gaps. A fresh eligible observation starts a new segment. The chart never fills an outage or stretches an old price to the present. A browser reconnect reloads server history; it does not invent missed transitions in Recent moves. Chart timestamps mean when the server observed a price, not when the sportsbook's trading system changed it. Opening a chart does not add sportsbook requests.

Cloud history checkpoints run every 60 seconds, separately from live delivery, with verified TLS and bounded database operations. A crash can lose observations since the last successful checkpoint: the nominal 60-second cadence plus time to save it, or longer if storage has been unavailable. If storage fails, the board and in-memory history continue; the chart explains that limitation. The free Render PostgreSQL instance expires **November 28, 2026**, so retained history needs migration or export before then. The [October 29 restart check](measurements/history-restart-20261029.json) compared 12 saved prices across all six main selections at both books for Baltimore–Buffalo. All 12 survived the restart from `8f0148c` to `b14c22f` with the same times and values, and all 12 started separate fresh baselines afterward. Storage reported 348 restored series and no rejected rows. The [later `4deb501` restart check](measurements/history-persistent-restart-20261029.json) again preserved the 12 original points with separate fresh baselines and 348 restored series without rejected rows. These checks verify sampled restart behavior; they do not claim 48 elapsed hours of collected history.

## Optional controls and more markets

The eight added groups are alternate lines, player props, starred games, compact density, light/dark themes, board/grid layouts, keyboard shortcuts, and main-market analytics with margin/EV sorting. Stars and display preferences stay in this browser. Shortcuts avoid changing the board while you type; use the help control to see them.

**More markets** loads alternate spreads/totals and supported player ladders for touchdowns, passing/rushing/receiving yards and receptions. A label such as **50+** means at least 50; the implementation does not claim to cover every ordinary over/under prop. Prices are compared only for the same player or team, side, line and contract. Different early-exit or house protection rules are shown separately and are not ranked. This remains an NFL board; no other-league support is claimed.

These markets use a separate cloud child process and stream, refresh nominally every **15 seconds**, and become ineligible after **45 seconds** without confirmation. Work is shared across viewers, with at most **two active games** across the service. Closing the last viewer's panel stops collection for that game. An extra-market failure does not change main-feed health. The main push connections and FanDuel's parallel quarter-second checks are unchanged. DraftKings fetches all seven optional categories sequentially in one bounded anonymous, TLS-verified `curl_cffi` session owned by the extra-market worker, then publishes only a complete validated result. The process and session stay available across the 15-second cycles. Cancellation, worker shutdown or 60 seconds of inactivity closes the transport; a later request starts a fresh session. Seven-category, 8 MiB and 30-second batch limits remain in place. This avoids repeated Python startup and does not change main-market collection.

The [earlier `8f0148c` observation](measurements/extras-loaded-cloud-observation-20261029.json) showed why this mattered: with two extra-market panels open, FanDuel completed 203 main-price cycles in 60 seconds and DraftKings extras took about 13–17 seconds per request. That separate-process design still shared host resources. Those results and the intermediate `b14c22f` comparison remain part of the record alongside the newer persistent-session observations. Neither a successful accuracy check nor a quiet stream proves changed-price speed.

The [loaded `4deb501` observation](measurements/extras-persistent-loaded-20261029.json) then recorded 236 successful main FanDuel cycles over a 60.164-second metrics span, with no failed, partial or rate-limited cycles. Two extra games produced 16 updates without errors or worker restarts; eight DraftKings batches took 1.09–1.89 seconds and eight FanDuel extra reads took 75–197 ms. History checkpointing also continued. This describes a healthy observed minute under load; viewer counts were not fixed and no main prices changed, so it does not prove zero overhead or changed-price speed. Two earlier controlled attempts were invalidated by a change in viewer count; their reports are retained, and their incomplete windows are not used to infer overhead or app failure.

The [third attempt](measurements/extras-persistent-cloud-comparison-stable-20261029.json) completed two stable windows on the same server: 238 main FanDuel cycles in 60.101 seconds with extras closed, then 235 in 60.107 seconds with two games open. That is **1.27% lower observed polling throughput**, not proof of zero overhead. During the open window, eight DraftKings batches averaged **1.070 seconds** with **1.498 seconds p95**; eight FanDuel extra reads averaged **117.69 ms** with **191.45 ms p95**. No source errors, partial or rate-limited main cycles, or actual price changes occurred in those completed windows. Another viewer joined during the final closed window, so the full three-window test remained **unsuccessful**. The saved report keeps that failure and the two valid windows; sequential network variation still prevents a causal overhead claim or a bookmaker-to-screen speed conclusion.

The analytics need both books' complete, active, fresh prices on the same two-outcome contract. Implied margin describes quoted prices. Fair probabilities remove each book's quoted margin and average the results; EV is a market-derived estimate conditional on a settled win/loss, not an independent prediction. Pushes, tie-voids and cancellations are not modeled. An arbitrage candidate is not a guarantee that both prices can be executed or settle identically.

## Why the two collectors are different

A **snapshot** is a full picture of the requested state. A **delta** contains only changes to that picture. DraftKings can send a selection ID and a new price without repeating its game or market. The collector merges the change into existing state instead of replacing the whole selection with an incomplete object.

FanDuel's HTTP price response is a snapshot for a batch of requested markets. Its endpoint silently truncated a request for 87 markets to 80. Splitting requests into groups of at most 70 restores all 87 markets and 174 prices. Requested and returned counts are now checked explicitly. A missing market is removed and flagged; the app does not silently restore an old discovery price.

FanDuel's push feed sends updated market state. Its public connection configuration is read from the site's current JavaScript, and refreshed automatically if rejected. An acknowledgement alone contains no prices, so each reconnect also requires a fresh complete baseline. Updates arriving during a slow HTTP request keep flowing and take precedence over that request's response. A request started after the latest push can advance prices immediately, because HTTP may lead the push feed. The source timestamps are not precise enough to guarantee perfect ordering between every push and HTTP snapshot; that limitation is explicit.

A **WebSocket** is a persistent two-way connection. Both bookmakers use it to push changes. **Server-sent events (SSE)** are a simpler persistent server-to-browser stream. Our board uses SSE because viewers mostly receive updates. The browser detects a silent stream after 12 seconds, reconnects with increasing delays, and requires a fresh full board before applying subsequent changes. A two-second heartbeat proves that the browser connection answers, not that either bookmaker is fresh. Returning to a hidden tab checks the connection immediately; background timer suspension can delay detection until the browser runs again. Price changes and source failures go out immediately, while repeated confirmation timestamps are condensed into smaller messages.

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

We can time our requests and processing. For changed games in view, the browser estimates rendering time after two animation frames and corrects for its clock difference from the server. Clock checks have timeouts, cannot overlap, and use a monotonic estimate so changing the laptop clock does not make current messages appear old. That estimate is not a physical screen measurement.

DraftKings provides feed timestamps, but they do not prove the exact time its trading system changed the price. FanDuel's push timestamp has only whole-second precision, so a reported age can include almost a second of rounding. Its HTTP response has no change timestamp. Push avoids an intentional polling wait; the parallel quarter-second HTTP checks add roughly zero to a quarter-second of polling wait when they are the first path to expose a change, under normal operation. Those are design properties, not measured end-to-end guarantees.

The saved local test captured two DraftKings changed-price rendering samples, approximately 58–61 ms after backend receipt. The first working cloud observation also received real DraftKings price changes, but its remote CLI clock was not synchronized and produced invalid negative delivery times. That exposed a measurement problem; the benchmark now calibrates its clock first. Do not reuse those invalid numbers as a speed claim. Neither source has been measured during an actual NFL game yet. Use the exact sample counts and limitations from the README.

The corrected cloud observation captured two more DraftKings changes at approximately 70–73 ms from backend receipt to the remote command-line observer, with at least ±25 ms clock uncertainty. This verifies the live delivery path, but it is still only two pregame samples and does not time browser rendering. FanDuel stayed healthy without a price change during that short window, so its change-delivery row remains unmeasured.

At 8:06 p.m. Toronto time on October 28, the earlier New Jersey FanDuel configuration also delivered actual changes for Atlanta at Tampa Bay. HTTP caught a total-line change first; push caught the subsequent moneyline change first. Processing in our store took about 1.17 and 1.75 ms respectively. This is why we keep both paths active. These two correlated messages prove actual price delivery through the public stream; they do not establish a broad latency distribution, browser-paint timing, or live-game performance.

After the Ontario migration, independent checks matched all 174 FanDuel quotes and all 174 DraftKings quotes against fresh official Ontario responses, and the complete test suite passed 65 tests. The public board showed 29 matched games and 348 prices. A 330-second Ontario observation received two DraftKings changed-price messages in about 28–31 ms after backend receipt, with at least ±29 ms clock uncertainty. No FanDuel changed-price message was observed during that window, so its Ontario change-delivery time remains unmeasured. An acknowledged Ontario push connection proves subscription setup, not delivery speed. Use these current results and keep the older New Jersey measurements clearly identified.

A later [Ontario observation](measurements/render-ontario-first-push.json), at 10:21–10:26 p.m. Toronto time on October 28, did receive actual FanDuel price pushes through the public stream: Green Bay's moneyline moved from −190 to −200 and Carolina's from +160 to +168. Store processing took about 2.12 and 4.82 ms. This proves the Ontario push path delivered changed prices; it does not measure bookmaker-to-screen latency. The two updates were on one pregame game, before the quarter-second polling change. The later 86-test release covered scheduling, presentation, source gaps and reconnect-history cases; both that count and the 65-test migration result are historical.

The UI and quarter-second checks were deployed as `1365228`. The [new deployment report](measurements/render-ui-speed-deployment-verification.json) confirms both Ontario feeds and identical boards for two viewers; fresh independent source checks again matched all 348 quotes. All 86 automated tests passed. Browser replay checks exercised payout arrows, separate line and availability changes, stale-source exclusion, reconnects and history at desktop and 375px widths. Those reports describe that release; the older measurements above retain their original settings and limitations.

The [post-deployment observation](measurements/render-ui-speed-pregame-observation.json) ran two fixed five-minute windows. Across their baseline and grace metadata spans, 2,532 complete FanDuel checks succeeded without failures, partial responses or rate limits. Neither window contained a price change, so they cannot establish actual change-delivery speed. One receive gap crossed the end of the first window; the server continued collecting and sending timestamped status messages, which reached the observer later in a burst. The delivery layer causing that delay is still unresolved. This is why a configured quarter-second interval is not a promise that every viewer sees every update within a quarter-second.

The subsequent stream-recovery release is **`2bffe9c`**, verified October 29 at 11:44 a.m. Toronto time. That release passed all 106 automated tests, and fresh independent checks again matched all 348 Ontario quotes. It sends smaller routine confirmations, detects silently open browser streams and uses bounded clock checks. A controlled 50-cycle test used 82.4% fewer SSE application bytes; changed prices and source failures still bypass that batching. The [one-minute public check](measurements/render-stream-recovery-observation.json) observed 218 compact confirmations, 30 transport heartbeats and 239 successful complete FanDuel cycles across the surrounding metadata span, with no failed, partial or rate-limited cycles. There were no actual price changes, so this is traffic and health evidence, not proof of faster price delivery. Chrome fault injection verified reconnection to a current snapshot without inventing movements missed during the outage. Safari's background timers could be suspended; returning to the tab detected the gap, so the 12-second deadline is not an absolute background-time guarantee.

The repeatable cloud load check is `node --use-system-ca scripts/observe-extras-cloud.js <runtime-commit> docs/measurements/<new-file>.json`. It measures 60 seconds with extras closed, 60 seconds with two healthy extra-market games open, then 60 seconds closed, on the same server process. Close other extra panels and keep viewers unchanged. It refuses to overwrite evidence and rejects changed workloads or unhealthy sources. Read polling throughput and SSE continuity separately from actual price-change speed.

## Demo sequence

1. Run `npm ci` and `npm start`, then open `http://localhost:3210`.
2. Check both source indicators before comparing prices. Open Best Price, DraftKings and FanDuel in turn.
3. Find a game present at both books. Compare moneyline, spread and total rows. Explain why different point lines are separate.
4. Switch between American and decimal odds. Copy the resulting URL to show that source and format are shareable.
5. Select a price to open its server history, then open Recent moves. Explain the difference between retained server observations and this tab's recent transitions, along with visible gaps and storage status. Do not present a fixture replay as a real sportsbook change.
6. Open a second tab. Both tabs share the main collectors and retained server history; Recent moves starts separately in each tab. Try the themes, density, layouts, stars and shortcut help.
7. Open More markets for one game. Explain its slower refresh and separate health, inclusive N+ labels and contract restrictions. Open `/api/metrics` to show main health and sample counts; a zero live sample count means “not measured.”
8. Show the public Render page with both sources connected. Explain the snapshot transport fix, the free host's sleep limitation, and the distinction between verified pregame data and still-outstanding in-game measurements.

For the remaining live-game check, observe both source pages and the board during an actual NFL game. Verify live status, suspensions and reopenings, changed prices, and changed lines. Save the measurement report with its environment, observation window and sample counts. A fixture replay can test logic but cannot replace this observation.

## Questions to answer in your own words

- Why do we fetch once per sportsbook rather than once per viewer?
- Why can a price-only DraftKings message not replace the whole selection?
- Why are -3 and -3.5 separate comparisons?
- What does a healthy connection tell us, and what does it not tell us about an unchanged quote?
- Why does a fast FanDuel request not prove how quickly a changed price reaches us?
- What evidence would establish live-game performance?
- Why is the current board rebuilt from live feeds while historical observations can be restored from a database?
- Why can two props with the same player and number still have different settlement rules?
- Why is a market-derived EV estimate not an independent forecast?
- If we ran three web servers, how would we avoid starting three collectors per book?

For the final question: separate ingestion from serving, keep one owner per source, and distribute updates to the web servers through a shared message service. That is a next step, not functionality claimed by this version.

Codex assisted with implementation and documentation. Review the code, run the demo and explain these choices yourself before submitting.
