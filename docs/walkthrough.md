# Understand and demonstrate Fieldline

This guide explains the implemented code. It is not a claim that every requirement has been verified. The README's current status and saved measurements are the record of what actually works.

## The whole system in one minute

Fieldline collects NFL odds from two sportsbooks, turns their different formats into the same structure, and shows comparable prices in one board. Each sportsbook has one collector running on the server. Every viewer shares those results, so opening ten tabs does not create ten sets of sportsbook requests.

DraftKings supplies an initial list of games and prices, then pushes changes over a persistent connection. FanDuel's observed public page obtains prices by repeatedly requesting them. We use the same public price endpoint every two seconds. The server then pushes board changes to browsers immediately.

The shared data lives in memory. We only need the current board for this prototype, so adding a database would add work without solving a current requirement. A restart fetches the current state again.

## What an odds update means

Suppose a team is offered at **+120** by DraftKings and **+115** by FanDuel. A $100 winning bet would make $120 or $115 profit, respectively. For that same outcome, +120 is the better price.

The comparison changes for spreads. **Team -3 at -110** and **Team -3.5 at +100** have different winning conditions. The app keeps those lines separate. It compares prices only when the game, period, market, side and point line match. Ties show both books.

One source might call a team “CAR Panthers” and the other “Carolina Panthers.” Explicit team aliases give them the same identity. Unknown names are flagged rather than guessed. The app also checks game date, home/away orientation and kickoff differences to avoid merging unrelated events.

## Why the two collectors are different

A **snapshot** is a full picture of the requested state. A **delta** contains only changes to that picture. DraftKings can send a selection ID and a new price without repeating its game or market. The collector merges the change into existing state instead of replacing the whole selection with an incomplete object.

FanDuel's price response is a snapshot for a batch of requested markets. A market missing from that response is removed; the app does not silently restore an old price from its discovery response.

A **WebSocket** is a persistent two-way connection. DraftKings uses it to push changes. **Server-sent events (SSE)** are a simpler persistent server-to-browser stream. Our board uses SSE because viewers mostly receive updates. Browsers reconnect automatically and receive a fresh full board before subsequent changes.

## What happens when something breaks

Each source has its own state and retry cycle. A failing DraftKings collector cannot stop FanDuel. Detected failures immediately mark the source stale, and stale or suspended offers cannot win Best Price. Previously known stale prices may remain visible in that source's own view with a clear label.

Retries grow farther apart after repeated failures, with a small random variation to avoid synchronized bursts. HTTP errors that include Retry-After also feed that instruction into the retry delay. The DraftKings handshake/snapshot error is preserved when the socket subsequently closes, so the useful cause remains visible.

The hosted access issue is a real example: Render can subscribe to DraftKings' stream but receives HTTP 403 for the initial snapshot. A working stream alone is insufficient, because partial updates need an initial state. A second deployment in Toronto on Fly also receives HTTP 403, including for the stream handshake and public NFL page. FanDuel continues operating on both hosts. Locally both source integrations work. Do not demonstrate either hosted page as a complete two-source result until that blocker is resolved. Upgrading hosting has not been shown to fix the source-access failure.

## How to talk about speed accurately

There are different intervals:

1. The sportsbook changes a price, then makes it available in its feed.
2. Our collector receives it and updates the shared board.
3. The update travels to the browser and appears on screen.

We can time our requests and processing. For changed games in view, the browser estimates rendering time after two animation frames and corrects for its clock difference from the server. That estimate is not a physical screen measurement.

DraftKings provides feed timestamps, but they do not prove the exact time its trading system changed the price. FanDuel's inspected response has no price-change timestamp. Its two-second polling interval adds roughly zero to two seconds of waiting under normal operation; that is a model, not a measured end-to-end guarantee.

The saved local test captured two DraftKings changed-price rendering samples, approximately 58–61 ms after backend receipt. Two samples are too few for a robust performance claim. Neither source has been measured during an actual NFL game yet. Use the exact sample counts and limitations from the README.

## Demo sequence

1. Run `npm ci` and `npm start`, then open `http://localhost:3210`.
2. Check both source indicators before comparing prices. Open Best Price, DraftKings and FanDuel in turn.
3. Find a game present at both books. Compare moneyline, spread and total rows. Explain why different point lines are separate.
4. Open a second tab. Both tabs share the server's collectors and receive pushed updates.
5. Open `/api/metrics` to show source health and sample counts. A zero live sample count means “not measured.”
6. Show the public Render page and describe its current access limitation accurately.

For the remaining live-game check, observe both source pages and the board during an actual NFL game. Verify live status, suspensions and reopenings, changed prices, and changed lines. Save the measurement report with its environment, observation window and sample counts. A fixture replay can test logic but cannot replace this observation.

## Questions to answer in your own words

- Why do we fetch once per sportsbook rather than once per viewer?
- Why can a price-only DraftKings message not replace the whole selection?
- Why are -3 and -3.5 separate comparisons?
- What does a healthy connection tell us, and what does it not tell us about an unchanged quote?
- How can FanDuel's request take 20 ms while a price still takes more than a second to reach us?
- What evidence would establish live-game performance?
- Why does this prototype use memory instead of a database?
- If we ran three web servers, how would we avoid starting three collectors per book?

For the final question: separate ingestion from serving, keep one owner per source, and distribute updates to the web servers through a shared message service. That is a next step, not functionality claimed by this version.

Codex assisted with implementation and documentation. Review the code, run the demo and explain these choices yourself before submitting.
