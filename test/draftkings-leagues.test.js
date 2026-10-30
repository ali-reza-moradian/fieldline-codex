import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { team, makeGame, makeQuote, compareQuotes } from "../src/model.js";
import { leagueForDraftKings, leagueForCompetition, DRAFTKINGS_LEAGUES } from "../src/leagues.js";
import { DraftKings, DraftKingsState, DraftKingsSnapshotClient, snapshotUrl, subscription } from "../src/adapters/draftkings.js";
import { OddsStore } from "../src/store.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const raw = fixture("draftkings-leagues");
function forLeague(id) {
  const events = raw.events.filter(e => e.leagueId === id), ids = new Set(events.map(e => e.id));
  const markets = raw.markets.filter(m => ids.has(m.eventId)), mids = new Set(markets.map(m => m.id));
  return { events, markets, selections: raw.selections.filter(s => mids.has(s.marketId)) };
}
const waitFor = async fn => {
  const deadline = Date.now() + 2500;
  while (!fn()) { if (Date.now() > deadline) throw new Error("Test condition timed out"); await new Promise(r => setTimeout(r, 5)); }
};

test("league identity is explicit and college aliases never confuse similarly named schools", () => {
  assert.equal(leagueForDraftKings("87637"), "ncaaf");
  assert.equal(leagueForDraftKings("154752"), "ncaaf");
  assert.equal(leagueForCompetition(12623176), "ncaaf");
  assert.equal(leagueForCompetition(12488538), "cfl");
  assert.equal(leagueForCompetition(11353530), null, "CFL futures are not game lines");
  assert.equal(team("Connecticut", "ncaaf").id, team("UConn", "ncaaf").id);
  assert.equal(team("Miami Florida", "ncaaf").id, team("Miami FL", "ncaaf").id);
  assert.notEqual(team("Miami Florida", "ncaaf").id, team("Miami Ohio", "ncaaf").id);
  assert.notEqual(team("North Dakota", "ncaaf").id, team("North Dakota State", "ncaaf").id);
  assert.notEqual(team("San Diego", "ncaaf").id, team("San Diego State", "ncaaf").id);
  assert.throws(() => team("Bulldogs", "ncaaf"), /Unrecognized/);
  assert.throws(() => team("Miami", "ncaaf"), /Unrecognized/);
  assert.throws(() => team("New Mystery School", "ncaaf"), /Unrecognized/);
  assert.throws(() => team("Toronto Argonauts"), /Unrecognized NFL/);
  assert.equal(team("TOR Argonauts", "cfl").id, team("Toronto Argonauts", "cfl").id);
});

test("NFL IDs retain persistent history while other leagues are namespaced", () => {
  assert.equal(makeGame("draftkings", 1, "CAR", "GB", "2026-10-30T00:15:00Z").id, "2026-10-29:CAR:GB");
  const a = makeGame("draftkings", 1, "Florida Atlantic", "North Texas", "2026-10-30T00:00:00Z", false, "ncaaf");
  const b = makeGame("fanduel", 2, "Florida Atlantic", "North Texas", "2026-10-30T00:01:00Z", false, "ncaaf");
  assert.equal(a.id, b.id); assert.equal(a.league, "ncaaf"); assert.match(a.id, /^ncaaf:/);
  assert.match(makeGame("draftkings", 3, "WPG Blue Bombers", "TOR Argonauts", "2026-10-30T00:00:00Z", false, "cfl").id, /^cfl:/);
});

test("an incomplete league baseline cannot win a best-price comparison", () => {
  const now = Date.now(), game = makeGame("fanduel", "example", "Florida Atlantic", "North Texas", "2026-10-30T00:00:00Z", false, "ncaaf");
  const quote = makeQuote(game, "moneyline", "away", null, 150, "selection");
  const source = { status: "healthy", lastConfirmedAt: now, staleAfterMs: 10000 };
  for (const coverage of [
    { requested: 9, returned: 8, missingIds: ["absent"] },
    { requested: 9, returned: 9, missingIds: ["contradiction"] },
    { requested: 0, returned: 0, missingIds: [] },
    { requested: 9, returned: 9 },
  ]) {
    const [group] = compareQuotes([quote], { fanduel: { ...source, coverage } }, now);
    assert.deepEqual(group.bestBooks, []); assert.equal(group.offers[0].stale, true);
  }
  for (const coverage of [undefined, { requested: 9, returned: 9, missingIds: [] }])
    assert.deepEqual(compareQuotes([quote], { fanduel: { ...source, coverage } }, now)[0].bestBooks, ["fanduel"]);
});

test("recorded Ontario college, FCS and CFL entities retain main lines, sides and availability", () => {
  const state = new DraftKingsState(); state.replace(raw); const normalized = state.normalize();
  assert.equal(normalized.games.length, raw.events.length); assert.equal(normalized.quotes.length, raw.selections.length);
  assert.deepEqual(new Set(normalized.games.map(g => g.league)), new Set(["ncaaf", "cfl"]));
  assert.deepEqual(normalized.warnings, []);
  for (const quote of normalized.quotes) {
    const selection = raw.selections.find(s => s.id === quote.sourceId);
    assert.equal(quote.side, selection.outcomeType.toLowerCase());
    assert.equal(quote.line, quote.market === "moneyline" ? null : selection.points);
    assert.equal(quote.american, Number(selection.displayOdds.american.replace("−", "-")));
    assert.equal(quote.period, "full_game");
  }
  const selection = raw.selections[0], copy = structuredClone(raw);
  copy.selections.find(s => s.id === selection.id).isSuspended = true;
  state.replace(copy); assert.equal(state.normalize().quotes.find(q => q.sourceId === selection.id).suspended, true);
});

test("recorded Ontario in-play primary markets retain all twelve real college prices", () => {
  const live = fixture("draftkings-ontario-live-college"), state = new DraftKingsState();
  state.replace(live); const result = state.normalize();
  assert.equal(result.games.length, 2); assert.equal(result.quotes.length, 12);
  assert.ok(result.games.every(game => game.live && game.league === "ncaaf"));
  assert.deepEqual(result.warnings, []);
  for (const game of result.games) assert.equal(result.quotes.filter(q => q.gameId === game.id).length, 6);
  for (const q of result.quotes) {
    const selection = live.selections.find(s => s.id === q.sourceId);
    const market = live.markets.find(m => m.id === selection.marketId);
    assert.equal(q.market, market.name.toLowerCase());
    assert.equal(q.side, selection.outcomeType.toLowerCase());
    assert.equal(q.line, q.market === "moneyline" ? null : selection.points);
    assert.equal(q.american, Number(selection.displayOdds.american.replace("−", "-")));
    assert.equal(q.period, "full_game");
  }
  const selection = live.selections[0];
  const delta = { add: { events: [], markets: [], selections: [] },
    change: { events: [], markets: [], selections: [{ id: selection.id, isSuspended: true }] },
    remove: { events: [], markets: [], selections: [] } };
  state.apply(delta);
  assert.equal(state.normalize().quotes.find(q => q.sourceId === selection.id).suspended, true);
  delta.change.selections = [{ id: selection.id, isSuspended: false, displayOdds: { american: "+255" } }];
  state.apply(delta);
  const reopened = state.normalize().quotes.find(q => q.sourceId === selection.id);
  assert.equal(reopened.suspended, false); assert.equal(reopened.american, 255);
});

test("kickoff market replacement preserves game identity and removes the pregame contracts", () => {
  const live = fixture("draftkings-ontario-live-college"), state = new DraftKingsState();
  state.replace(raw);
  const before = state.normalize(), eventIds = new Set(live.events.map(e => e.id));
  const removedMarkets = new Set(raw.markets.filter(m => eventIds.has(m.eventId)).map(m => m.id));
  const removedSelections = new Set(raw.selections.filter(s => removedMarkets.has(s.marketId)).map(s => s.id));
  state.apply({ add: { events: [], markets: live.markets, selections: live.selections },
    change: { events: live.events, markets: [], selections: [] },
    remove: { events: [], markets: [...removedMarkets], selections: [...removedSelections] } });
  const after = state.normalize();
  assert.deepEqual(after.games.map(g => g.id), before.games.map(g => g.id));
  assert.equal(after.quotes.length, before.quotes.length);
  assert.ok(after.quotes.every(q => !removedSelections.has(q.sourceId)));
  for (const event of live.events) {
    const game = after.games.find(g => g.sourceId === event.id);
    assert.equal(game.live, true);
    assert.equal(after.quotes.filter(q => q.gameId === game.id).length, 6);
  }
  assert.deepEqual(after.warnings, []);
});

test("live types require explicit primary full-game identity and never admit a half or unknown period", () => {
  const live = fixture("draftkings-ontario-live-college");
  for (const mutate of [
    market => { market.marketType.id = "1_2"; },
    market => { market.subcategoryId = "9999"; },
    market => { market.name = "1st Quarter Moneyline"; },
    market => { market.marketType.name = "1st Half Moneyline"; },
    market => { market.tags = market.tags.filter(tag => tag !== "PrimaryMarket"); },
  ]) {
    const data = structuredClone(live), changed = data.markets.find(m => m.marketType.id === "1_39");
    mutate(changed);
    const excluded = new Set(data.selections.filter(s => s.marketId === changed.id).map(s => s.id));
    const state = new DraftKingsState(); state.replace(data);
    const result = state.normalize();
    assert.equal(result.quotes.length, 10);
    assert.ok(result.quotes.every(q => !excluded.has(q.sourceId)));
    if (changed.marketType.id === "1_2") assert.match(result.warnings.join(" "), /Unsupported DraftKings primary market/);
  }
});

test("every subscription and snapshot keeps Ontario and a verified league/category", () => {
  for (const { sourceId } of DRAFTKINGS_LEAGUES) {
    const url = new URL(snapshotUrl(sourceId)), sub = subscription("test", sourceId);
    assert.match(url.pathname, /CA-ON-SB/); assert.equal(url.searchParams.get("templateVars"), sourceId);
    assert.ok(sub.params.queryParams.query.includes(`leagueId eq '${sourceId}'`));
    assert.match(sub.params.queryParams.includeMarkets, /4518/); assert.equal(sub.params.siteName, "dkcaon");
  }
  assert.throws(() => snapshotUrl("unknown"), /Unsupported/);
});

test("persistent snapshot transport publishes a complete merged baseline and closes its owned session", async () => {
  let calls = 0, closed = false;
  const client = { fetch: async requests => { calls++; return requests.map(r => ({ id: r.id, data: forLeague(r.id), receivedAt: Date.now(), decodedBytes: 100, durationMs: 1 })); }, close: () => { closed = true; } };
  const fetcher = new DraftKingsSnapshotClient({ transport: "curl", client, leagueIds: ["87637", "154752", "33567"] });
  const first = await fetcher.fetch(), second = await fetcher.fetch();
  assert.equal(calls, 2); assert.equal(first.data.events.length, raw.events.length);
  assert.equal(second.data.selections.length, raw.selections.length); assert.equal(first.decodedBytes, 300);
  fetcher.close(); assert.equal(closed, true);
});

test("missing, duplicated, wrong-league and failed league responses never become a partial baseline", async () => {
  const response = (id, data = forLeague(id)) => ({ id, data, receivedAt: Date.now(), decodedBytes: 100 });
  for (const rows of [
    [response("87637")],
    [response("87637"), response("87637")],
    [response("87637"), response("33567", forLeague("87637"))],
    [response("87637"), response("33567", { events: [] })],
  ]) {
    const fetcher = new DraftKingsSnapshotClient({ transport: "curl", leagueIds: ["87637", "33567"], client: { fetch: async () => rows, close() {} } });
    await assert.rejects(fetcher.fetch());
  }
  const fetcher = new DraftKingsSnapshotClient({ transport: "native", leagueIds: ["87637", "33567"], nativeFetch: async url => {
    if (url.includes("33567")) throw new Error("CFL source denied"); return response("87637");
  } });
  await assert.rejects(fetcher.fetch(), /CFL source denied/);
});

test("a failed native league cancels sibling requests before returning the original denial", async () => {
  const denial = Object.assign(new Error("CFL source denied"), { status: 429, retryAfterMs: 18000 });
  let siblingAborted = false;
  const fetcher = new DraftKingsSnapshotClient({ transport: "native", leagueIds: ["87637", "33567"],
    nativeFetch: (url, { signal }) => url.includes("33567") ? Promise.reject(denial) : new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { siblingAborted = true; reject(signal.reason); }, { once: true });
    }) });
  await assert.rejects(fetcher.fetch(), error => error === denial && error.retryAfterMs === 18000);
  assert.equal(siblingAborted, true);
});

function priceUpdate(id, selectionId, american, padding = "") {
  const empty = () => ({ events: [], markets: [], selections: [] });
  return { id, event: "update", padding, data: { data: { add: empty(), remove: empty(),
    change: { ...empty(), selections: [{ id: selectionId, displayOdds: { american: String(american) } }] } } } };
}

test("all four leagues replay prices buffered before acknowledgement and during a held baseline", async () => {
  const nfl = fixture("draftkings-snapshot"), baseline = Object.fromEntries(
    ["events", "markets", "selections"].map(kind => [kind, [...nfl[kind], ...raw[kind]]]));
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(upstream, "listening");
  const requests = [], expected = new Map(); let snapshots = 0, release;
  upstream.on("connection", socket => socket.on("message", message => requests.push({ socket, request: JSON.parse(message) })));
  const store = new OddsStore(), collector = new DraftKings(store, { socketUrl: `ws://127.0.0.1:${upstream.address().port}`,
    snapshotFetch: async () => { snapshots++; await new Promise(r => { release = r; });
      return { data: baseline, receivedAt: Date.now(), decodedBytes: 1, durationMs: 1 }; } });
  try {
    collector.start(); collector.start(); await waitFor(() => requests.length === 4);
    assert.equal(upstream.clients.size, 1, "start is idempotent");
    for (let i = 0; i < requests.length; i++) {
      const { socket, request } = requests[i], leagueId = DRAFTKINGS_LEAGUES[i].sourceId;
      const eventIds = new Set(baseline.events.filter(e => e.leagueId === leagueId).map(e => e.id));
      const marketIds = new Set(baseline.markets.filter(m => eventIds.has(m.eventId)).map(m => m.id));
      const selections = baseline.selections.filter(s => marketIds.has(s.marketId));
      assert.ok(selections.length >= 2);
      request.selectionIds = selections.slice(0, 2).map(s => s.id);
      const price = 135 + i * 10; expected.set(selections[0].id, price);
      socket.send(JSON.stringify(priceUpdate(request.id, selections[0].id, price)));
      if (i < 3) socket.send(JSON.stringify({ id: request.id, event: "subscribed" }));
    }
    await waitFor(() => collector.buffer.length === 4);
    assert.equal(snapshots, 0); assert.ok(collector.bufferBytes > 0);
    requests[3].socket.send(JSON.stringify({ id: requests[3].request.id, event: "subscribed" }));
    await waitFor(() => snapshots === 1);
    for (let i = 0; i < requests.length; i++) {
      const { socket, request } = requests[i], price = -145 - i * 10;
      expected.set(request.selectionIds[1], price);
      socket.send(JSON.stringify(priceUpdate(request.id, request.selectionIds[1], price)));
    }
    await waitFor(() => collector.buffer.length === 8);
    assert.notEqual(store.sources.draftkings.status, "healthy");
    release(); await waitFor(() => store.sources.draftkings.status === "healthy");
    for (const [selectionId, american] of expected)
      assert.equal(store.datasets.draftkings.quotes.find(q => q.sourceId === selectionId)?.american, american);
    assert.equal(collector.buffer.length, 0); assert.equal(collector.bufferBytes, 0);
  } finally { release?.(); collector.stop(); for (const socket of upstream.clients) socket.terminate(); await new Promise(r => upstream.close(r)); }
});

test("buffered stream bytes are bounded and overflow aborts the incomplete baseline", async () => {
  const baseline = fixture("draftkings-snapshot"), failures = [];
  const update = priceUpdate("placeholder", baseline.selections[0].id, 140, "x".repeat(300));
  const maxBufferedBytes = Buffer.byteLength(JSON.stringify(update)) + 100;
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(upstream, "listening");
  const requests = []; let snapshotStarted = false, snapshotAborted = false;
  upstream.on("connection", socket => socket.on("message", message => requests.push({ socket, request: JSON.parse(message) })));
  const collector = new DraftKings({ failure: (_book, error) => failures.push(error), update() { throw new Error("Incomplete baseline published"); } }, {
    socketUrl: `ws://127.0.0.1:${upstream.address().port}`, maxBufferedBytes,
    snapshotFetch: ({ signal }) => new Promise((resolve, reject) => { snapshotStarted = true;
      signal.addEventListener("abort", () => { snapshotAborted = true; reject(signal.reason); }, { once: true }); }) });
  try {
    collector.start(); await waitFor(() => requests.length === 4);
    for (const { socket, request } of requests) socket.send(JSON.stringify({ id: request.id, event: "subscribed" }));
    await waitFor(() => snapshotStarted);
    const { socket, request } = requests[0]; update.id = request.id;
    socket.send(JSON.stringify(update)); await waitFor(() => collector.buffer.length === 1);
    assert.ok(collector.bufferBytes <= maxBufferedBytes);
    socket.send(JSON.stringify(update)); await waitFor(() => snapshotAborted);
    assert.ok(failures.some(error => /Stream buffer limit exceeded/.test(error.message)));
    assert.equal(collector.bufferBytes, 0); assert.equal(collector.buffer.length, 0);
  } finally { collector.stop(); for (const socket of upstream.clients) socket.terminate(); await new Promise(r => upstream.close(r)); }
});

test("all league subscriptions acknowledge before baseline; reconnect remains stale until rebuilt", async () => {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(upstream, "listening");
  const sockets = [], requests = [];
  upstream.on("connection", socket => { sockets.push(socket); socket.on("message", raw => requests.push({ socket, request: JSON.parse(raw) })); });
  let snapshots = 0, release;
  const store = new OddsStore(), collector = new DraftKings(store, { socketUrl: `ws://127.0.0.1:${upstream.address().port}`,
    snapshotFetch: async () => { snapshots++; if (snapshots === 2) await new Promise(r => { release = r; }); return { data: fixture("draftkings-snapshot"), receivedAt: Date.now(), decodedBytes: 1, durationMs: 1 }; } });
  try {
    collector.start(); await waitFor(() => requests.length === 4);
    for (const { socket, request } of requests.slice(0, 3)) socket.send(JSON.stringify({ id: request.id, event: "subscribed" }));
    await new Promise(r => setTimeout(r, 20)); assert.equal(snapshots, 0);
    requests[3].socket.send(JSON.stringify({ id: requests[3].request.id, event: "subscribed" }));
    await waitFor(() => store.sources.draftkings.status === "healthy");
    const previousClient = collector.ws;
    sockets[0].terminate(); await waitFor(() => requests.length === 8);
    assert.equal(store.sources.draftkings.status, "stale");
    for (const { socket, request } of requests.slice(4)) socket.send(JSON.stringify({ id: request.id, event: "subscribed" }));
    await waitFor(() => snapshots === 2); assert.equal(store.sources.draftkings.status, "stale");
    release(); await waitFor(() => store.sources.draftkings.status === "healthy");
    assert.equal(store.datasets.draftkings.quotes.length, 174);
    const currentHeartbeat = collector.heartbeat;
    previousClient.emit("open");
    assert.equal(collector.heartbeat, currentHeartbeat, "a superseded socket opening cannot replace the active heartbeat");
  } finally { release?.(); collector.stop(); for (const socket of upstream.clients) socket.terminate(); await new Promise(r => upstream.close(r)); }
});

test("fast first reconnect never bypasses repeated-failure backoff or Retry-After", () => {
  const collector = new DraftKings({}, { snapshotFetch: async () => ({}) });
  const first = collector.reconnectDelay(); assert.ok(first >= 250 && first < 300);
  const second = collector.reconnectDelay(); assert.ok(second >= 2000);
  assert.ok(collector.reconnectDelay({ status: 429, retryAfterMs: 15000 }) >= 15000);
  const denied = new DraftKings({}, { snapshotFetch: async () => ({}) });
  assert.ok(denied.reconnectDelay(new Error("Unexpected server response: 403")) >= 1000);
});
