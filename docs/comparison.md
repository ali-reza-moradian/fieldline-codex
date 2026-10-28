# Reproducible comparison of the two public apps

The [October 28 observation](measurements/head-to-head-2026-10-28.json) establishes
**no measured speed winner**. An intended five-minute run was interrupted after
about 199 seconds by a deployment of the other app. A two-minute retry completed,
with a temporary DraftKings source outage on that app. Neither run observed a
price or line change. The first baseline contained 174 identical DraftKings prices
and 160 identical shared FanDuel prices. After the deployment, the retry admitted
168 DraftKings and 154 FanDuel prices; one game's larger kickoff conflict excluded
six prices per book. Initial values are coverage checks, not latency samples.

The retry exposed a one-minute kickoff difference after the other app deployed.
The preserved raw events were reanalyzed with the 90-second matching tolerance
described below. That restored the shared comparison scope without changing any
price-change counts or producing a speed winner.

Run from this repository with Node 24:

```sh
npm run compare -- 300
```

The duration is in seconds (10–3600). Defaults compare Fieldline at
`https://fieldline-codex.onrender.com` with the other implementation at
`https://nfl-odds-board-hgim.onrender.com`. To change the URLs:

```sh
npm run compare -- 300 https://first-app.example https://second-app.example
```

The first URL must expose Fieldline's `/api/events` schema; the second must expose
the other app's `/api/stream` schema. This is a schema-specific comparison, not a
generic website benchmark. It only reads public endpoints. It does not alter either
app, add upstream bookmaker requests per viewer, or submit browser telemetry.

Both apps are warmed first. The same Node process opens both streams and waits
for both initial snapshots, then allows two seconds for settling. It timestamps
each incoming chunk with the same monotonic clock **before parsing**. Normalizing
and matching happen after collection, so differences in the adapters' processing
cost do not contaminate arrival times. There is no reliance on either server's or
the bookmaker's clock.

An eligible sample must be the same book, local game date, home and away teams,
full-game market, side, and complete old-to-new price/line transition. Quotes must
start active and identical on both apps. Kickoff times must be within 90 seconds;
the observed feeds can disagree by one minute. Larger conflicts are excluded and
reported. The initial snapshot, identical
refreshes, heartbeats, first appearances, and suspension changes do not count.
Both sources must report healthy when the transition arrives. A repeated
transition with multiple possible matches within 15 seconds is excluded as
ambiguous. Coverage differences and excluded/unmatched changes remain visible.

The test adds a 15-second grace period to match changes first seen near the end.
It reports both quote transitions and distinct pairs of stream events: six prices
in one update are correlated observations, not six independent network trials.
Negative `codexMinusClaudeMs` means Fieldline arrived first; positive means the
other app arrived first. No latency is invented for a change seen on only one
app. A stream interruption invalidates the complete-window comparison.

Files are written to `data/comparison-<timestamp>/`:

- `events.json`: raw received events and local monotonic timestamps, for audit.
- `result.json`: matching details, coverage, errors, observer scheduling delays,
  and both apps' public metrics before and after the observation.

This measures delivery to one HTTP client from one network location. It includes
the real acquisition, relay, server fan-out, and network differences between the
deployments. It does **not** measure browser drawing time, absolute time since a
bookmaker changed a price, cold-start performance, or independent source accuracy.
No general winner should be declared from a quiet window or a handful of
correlated price changes. Repeat during active NFL movement and, ideally, from
multiple observer locations.

The earlier standalone timing figures cannot determine a winner. Fieldline's
saved DraftKings feed-age statistic starts at `createdTime`; the other app uses
`publishedTime`. Their samples, windows, and rendering/receipt endpoints also
differ. FanDuel's 1-second versus 2-second polling intervals imply mean waiting
times of approximately 0.5 versus 1 second only under uniformly timed changes
and normal operation; these are estimates, not measured end-to-end guarantees.
