# Recorded public source responses

These fixtures were captured from logged-out public NFL odds endpoints on October 28, 2026, while investigating the two sites with Chrome DevTools and direct HTTP/WebSocket requests. They are test inputs, not the running app's data source. No browser cookies, account tokens, HAR files, or applicant documents are included.

- `draftkings-snapshot.json`: DraftKings Ontario game-lines snapshot, reduced to events, markets and selections.
- `draftkings-delta.json`: an actual price-only JSON WebSocket update, including provider metadata timestamps.
- `fanduel-discovery.json`: FanDuel New Jersey discovery response, restricted to NFL full-game moneyline, spread and total markets.
- `fanduel-prices.json`: the public price endpoint's response for discovered markets. Missing markets must not be filled from old discovery prices.

Tests modify copies of these fixtures to exercise hypothetical failures and live/suspended states. Those scenarios are simulations and do not establish live-game performance.
