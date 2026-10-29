# Recorded public source responses

These fixtures were captured from logged-out public NFL odds endpoints on October 28, 2026, while investigating the two sites with Chrome DevTools and direct HTTP/WebSocket requests. They are test inputs, not the running app's data source. No browser cookies, account tokens, HAR files, or applicant documents are included.

- `draftkings-snapshot.json`: DraftKings Ontario game-lines snapshot, reduced to events, markets and selections.
- `draftkings-delta.json`: an actual price-only JSON WebSocket update, including provider metadata timestamps.
- `fanduel-discovery.json`: FanDuel New Jersey discovery response, restricted to NFL full-game moneyline, spread and total markets.
- `fanduel-prices.json`: the public price endpoint's response for discovered markets. Missing markets must not be filled from old discovery prices.
- `fanduel-ontario-discovery.json`: Ontario `.ca` discovery captured October 29, 2026 UTC (October 28 in Toronto), retaining 29 NFL events and their 87 full-game moneyline, spread and total markets. Original entity fields are unchanged.
- `fanduel-ontario-prices.json`: all 87 Ontario price rows returned in batches of 70 and 17, containing 174 runner prices. All captured markets were open; tests simulate suspension by modifying copies.
- `fanduel-ontario-provenance.json`: official public application sources, endpoint URLs, capture timestamps, request headers and counts. The observed market ID prefix is provenance, not a permanent provider contract. Local request durations do not establish cloud or bookmaker-to-screen latency.

Tests modify copies of these fixtures to exercise hypothetical failures and live/suspended states. Those scenarios are simulations and do not establish live-game performance.
