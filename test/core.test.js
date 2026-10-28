import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  team,
  makeGame,
  makeQuote,
  compareQuotes,
  americanOdds,
  decimalOdds,
} from "../src/model.js";
import { DraftKings, DraftKingsState } from "../src/adapters/draftkings.js";
import {
  normalizeFanDuel,
  selectFanDuelMarkets,
} from "../src/adapters/fanduel.js";
import { OddsStore } from "../src/store.js";
import { retryDelay, UpstreamError } from "../src/http.js";
import { Metrics, distribution } from "../src/metrics.js";
import { createApp } from "../src/server.js";
import { WebSocketServer } from "ws";

test("DraftKings preserves an HTTP handshake failure after the socket closes", async () => {
  const upstream = createServer((req, res) => res.writeHead(403).end());
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const store = new OddsStore();
  const collector = new DraftKings(store, {
    socketUrl: `ws://127.0.0.1:${upstream.address().port}`,
  });
  try {
    collector.start();
    await new Promise((resolve) => collector.ws.once("close", resolve));
    assert.equal(store.sources.draftkings.status, "stale");
    assert.match(store.sources.draftkings.error, /Unexpected server response: 403/);
  } finally {
    collector.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
test("DraftKings delivers stream changes during a slow resnapshot and replays them into the replacement", async () => {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  let socket, subscriptionId, release;
  upstream.on("connection", (client) => {
    socket = client;
    client.on("message", (raw) => {
      subscriptionId = JSON.parse(raw).id;
      client.send(JSON.stringify({ id: subscriptionId, event: "subscribed" }));
    });
  });
  let requests = 0;
  const snapshotFetch = async () => {
    if (++requests > 1) await new Promise((resolve) => { release = resolve; });
    return { data: fixture("draftkings-snapshot"), receivedAt: Date.now(), durationMs: 1, decodedBytes: 1000 };
  };
  const store = new OddsStore();
  const collector = new DraftKings(store, { socketUrl: `ws://127.0.0.1:${upstream.address().port}`, snapshotFetch });
  try {
    const initial = once(store, "message");
    collector.start();
    await initial;
    assert.equal(store.sources.draftkings.status, "healthy");
    const refresh = collector.resnapshot(collector.ws);
    assert.equal(collector.syncing, true);
    const delta = fixture("draftkings-delta");
    delta.id = subscriptionId;
    const pushed = once(store, "message", { signal: AbortSignal.timeout(1000) });
    socket.send(JSON.stringify(delta));
    await pushed;
    const selectionId = delta.data.data.change.selections[0].id;
    const price = () => store.datasets.draftkings.quotes.find((q) => q.sourceId === selectionId).american;
    assert.equal(price(), -520, "the browser-facing store changes before the slow snapshot finishes");
    assert.equal(collector.syncing, true);
    release();
    await refresh;
    assert.equal(price(), -520, "the replacement snapshot cannot undo the buffered price change");
  } finally {
    release?.();
    collector.stop();
    for (const client of upstream.clients) client.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
const dk = () => {
  const state = new DraftKingsState();
  state.replace(fixture("draftkings-snapshot"));
  return state;
};
const fd = () =>
  normalizeFanDuel(
    selectFanDuelMarkets(fixture("fanduel-discovery")),
    fixture("fanduel-prices"),
  );
const emptyDelta = () =>
  Object.fromEntries(
    ["add", "change", "remove"].map((op) => [
      op,
      { events: [], markets: [], selections: [] },
    ]),
  );
const healthy = (now) =>
  Object.fromEntries(
    ["draftkings", "fanduel"].map((book) => [
      book,
      { status: "healthy", lastConfirmedAt: now, staleAfterMs: 10000 },
    ]),
  );
const game = (book) =>
  makeGame(
    book,
    "example",
    "Carolina Panthers",
    "Green Bay Packers",
    "2026-10-30T00:15:00Z",
  );
async function readFrame(response) {
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.split("\n\n")[0];
}

test("observed abbreviated team names map to unambiguous NFL identities", () => {
  for (const name of ["NY Jets", "New York Jets", "NYJ"])
    assert.equal(team(name).id, "NYJ");
  assert.notEqual(team("LA Rams").id, team("LA Chargers").id);
  assert.throws(() => team("New York"), /Unrecognized/);
});
test("matching tolerates the observed one-minute kickoff offset without merging different game dates", () => {
  const a = makeGame(
    "draftkings",
    1,
    "CAR Panthers",
    "GB Packers",
    "2026-10-30T00:15:00Z",
  );
  const b = makeGame(
    "fanduel",
    2,
    "Carolina Panthers",
    "Green Bay Packers",
    "2026-10-30T00:16:00Z",
  );
  assert.equal(a.id, b.id);
  assert.equal(a.id, "2026-10-29:CAR:GB");
  assert.notEqual(
    a.id,
    makeGame("fanduel", 3, "CAR", "GB", "2026-11-06T00:15:00Z").id,
  );
});
test("American odds handle Unicode minus and reject invalid prices", () => {
  assert.equal(americanOdds("−110"), -110);
  assert.equal(decimalOdds(150), 2.5);
  assert.ok(decimalOdds(-105) > decimalOdds(-110));
  for (const v of [null, "", 0, 50, "bad"])
    assert.throws(() => americanOdds(v));
});
test("best price compares equal lines, preserves ties, and excludes stale and suspended offers", () => {
  const now = Date.now(),
    a = makeQuote(game("draftkings"), "spread", "away", 3, -110, "a");
  const b = makeQuote(game("fanduel"), "spread", "away", 3.5, 100, "b");
  assert.equal(compareQuotes([a, b], healthy(now), now).length, 2);
  b.line = 3;
  b.american = -110;
  b.decimal = a.decimal;
  assert.deepEqual(compareQuotes([a, b], healthy(now), now)[0].bestBooks, [
    "draftkings",
    "fanduel",
  ]);
  const status = healthy(now);
  status.fanduel.lastConfirmedAt = now - 20000;
  assert.deepEqual(compareQuotes([a, b], status, now)[0].bestBooks, [
    "draftkings",
  ]);
  a.suspended = true;
  assert.deepEqual(compareQuotes([a, b], status, now)[0].bestBooks, []);
});
test("recorded DraftKings snapshot produces all 29 games and six main selections per game", () => {
  const result = dk().normalize();
  assert.equal(result.games.length, 29);
  assert.equal(result.quotes.length, 174);
  assert.deepEqual(result.warnings, []);
  assert.equal(
    result.quotes.find((q) => q.sourceId === "0HC84695615P350_3").line,
    3.5,
  );
});
test("real DraftKings price-only delta preserves the selection relationship and side", () => {
  const state = dk(),
    update = fixture("draftkings-delta").data.data;
  const change = update.change.selections[0],
    before = { ...state.selections.get(change.id) };
  state.apply(update);
  const after = state.selections.get(change.id);
  assert.equal(after.marketId, before.marketId);
  assert.equal(after.outcomeType, before.outcomeType);
  assert.equal(after.displayOdds.american, change.displayOdds.american);
  assert.equal(state.normalize().quotes.length, 174);
});
test("DraftKings removal cascades through markets and selections", () => {
  const state = dk(),
    delta = emptyDelta();
  delta.remove.events = ["34118182"];
  state.apply(delta);
  assert.equal(state.normalize().games.length, 28);
  assert.equal(state.normalize().quotes.length, 168);
});
test("unknown delta IDs fail closed so the collector can rebuild its snapshot", () => {
  const state = dk(),
    delta = emptyDelta();
  delta.change.selections = [
    { id: "unknown", displayOdds: { american: "+110" } },
  ];
  assert.throws(() => state.apply(delta), /resnapshot/);
  assert.throws(() => state.apply({ add: {} }), /schema/);
});
test("suspended DraftKings selections are visible but cannot win", () => {
  const state = dk(),
    delta = emptyDelta();
  delta.change.selections = [{ id: "0ML84695615_3", isSuspended: true }];
  state.apply(delta);
  assert.equal(
    state.normalize().quotes.find((q) => q.sourceId === "0ML84695615_3")
      .suspended,
    true,
  );
});
test("recorded FanDuel data normalizes home/away and over/under without using sort order", () => {
  const result = fd();
  assert.deepEqual(result.warnings, []);
  const car = result.quotes.filter((q) => q.gameId === "2026-10-29:CAR:GB");
  assert.equal(car.length, 6);
  assert.equal(
    car.find((q) => q.market === "spread" && q.side === "home").line,
    -3.5,
  );
  assert.equal(
    car.find((q) => q.market === "total" && q.side === "over").line,
    47.5,
  );
});
test("FanDuel missing markets are removed, not resurrected using old discovery prices", () => {
  const catalog = selectFanDuelMarkets(fixture("fanduel-discovery")),
    prices = fixture("fanduel-prices");
  const removed = prices[0].marketId;
  const result = normalizeFanDuel(
    catalog,
    prices.filter((p) => p.marketId !== removed),
  );
  assert.ok(result.quotes.every((q) => !q.sourceId.startsWith(removed + ":")));
  assert.throws(() => normalizeFanDuel(catalog, []), /no requested markets/);
});
test("FanDuel live and suspension flags survive normalization", () => {
  const catalog = selectFanDuelMarkets(fixture("fanduel-discovery")),
    prices = fixture("fanduel-prices");
  prices[0].inplay = true;
  prices[0].marketStatus = "SUSPENDED";
  const result = normalizeFanDuel(catalog, prices);
  const quotes = result.quotes.filter((q) =>
    q.sourceId.startsWith(prices[0].marketId + ":"),
  );
  assert.ok(quotes.length);
  assert.ok(quotes.every((q) => q.suspended));
  assert.equal(result.games.find((g) => g.id === quotes[0].gameId).live, true);
});
test("store keeps the other source updating when a source fails", () => {
  const store = new OddsStore();
  const timing = { receivedAt: Date.now(), kind: "poll" };
  store.update("draftkings", dk().normalize(), timing);
  store.update("fanduel", fd(), timing);
  store.failure("draftkings", new Error("simulated outage"));
  store.update("fanduel", fd(), timing);
  assert.equal(store.sources.draftkings.status, "stale");
  assert.equal(store.sources.fanduel.status, "healthy");
  assert.equal(store.snapshot().games.length, 29);
  const car = store.snapshot().games.find((g) => g.id === "2026-10-29:CAR:GB");
  assert.ok(
    compareQuotes(car.quotes, store.sources).every(
      (g) => !g.bestBooks.includes("draftkings"),
    ),
  );
});
test("store quarantines the same teams with an implausible kickoff mismatch", () => {
  const store = new OddsStore(),
    a = game("draftkings"),
    b = game("fanduel");
  b.startsAt = "2026-10-30T02:15:00Z";
  store.update(
    "draftkings",
    { games: [a], quotes: [], warnings: [] },
    { receivedAt: Date.now(), kind: "snapshot" },
  );
  store.update(
    "fanduel",
    { games: [b], quotes: [], warnings: [] },
    { receivedAt: Date.now(), kind: "poll" },
  );
  assert.equal(store.snapshot().games.length, 2);
  assert.ok(store.snapshot().games.some((g) => g.matchWarning));
});
test("repeated snapshots preserve the last actual price change timestamp", () => {
  const store = new OddsStore(),
    data = dk().normalize(),
    timing = { receivedAt: Date.now(), kind: "snapshot" };
  store.update("draftkings", data, timing);
  const before = store.datasets.draftkings.quotes[0].changedAt;
  store.update("draftkings", data, timing);
  assert.equal(store.datasets.draftkings.quotes[0].changedAt, before);
  assert.equal(store.sources.draftkings.priceChanges, 0);
});
test("a changed point line with a new source ID still counts as a price change", () => {
  const store = new OddsStore(),
    g = game("draftkings"),
    timing = { receivedAt: Date.now(), kind: "stream" };
  store.update(
    "draftkings",
    {
      games: [g],
      quotes: [makeQuote(g, "spread", "away", 3, -110, "old")],
      warnings: [],
    },
    timing,
  );
  store.update(
    "draftkings",
    {
      games: [g],
      quotes: [makeQuote(g, "spread", "away", 3.5, -110, "new")],
      warnings: [],
    },
    timing,
  );
  assert.equal(store.sources.draftkings.priceChanges, 1);
});
test("retry schedule honors Retry-After and increases after repeated failures", () => {
  assert.ok(
    retryDelay(1, new UpstreamError("rate limited", 429, 90000)) >= 90000,
  );
  assert.ok(retryDelay(5) >= 16000);
});
test("measurement report leaves missing live measurements empty", () => {
  const metrics = new Metrics(),
    result = metrics.report([], {});
  assert.equal(result.measurements.draftkings.live.feedCreatedToPaintMs.n, 0);
  assert.equal(
    result.measurements.fanduel.pregame.feedCreatedToPaintMs.p50,
    null,
  );
  assert.deepEqual(distribution([null, 1, 2, 3, NaN]), {
    n: 3,
    p50: 2,
    p95: 3,
    max: 3,
  });
  assert.equal(
    metrics.recordBrowser({
      book: "fanduel",
      phase: "live",
      backendToPaintMs: Infinity,
    }),
    false,
  );
});
test("two subscribed viewers receive a real captured price delta without making new source requests", async () => {
  const app = createApp({ ingest: false }),
    state = dk();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const controls = [new AbortController(), new AbortController()];
  try {
    const captured = fixture("draftkings-delta");
    // A distinct synthetic starting price ensures this real delta changes the board.
    state.selections.get(
      captured.data.data.change.selections[0].id,
    ).displayOdds.american = "+100";
    app.store.update("draftkings", state.normalize(), {
      receivedAt: Date.now(),
      kind: "snapshot",
    });
    const responses = await Promise.all(
      controls.map((c) => fetch(base + "/api/events", { signal: c.signal })),
    );
    await Promise.all(responses.map(readFrame));
    state.apply(captured.data.data);
    app.store.update("draftkings", state.normalize(), {
      receivedAt: Date.now(),
      kind: "stream",
    });
    const frames = await Promise.all(responses.map(readFrame));
    for (const frame of frames) {
      assert.match(frame.slice(0, 100), /event: delta/);
      const data = JSON.parse(
        frame
          .split("\n")
          .find((l) => l.startsWith("data: "))
          .slice(6),
      );
      const id = captured.data.data.change.selections[0].id;
      const q = data.upsertGames
        .flatMap((g) => g.quotes)
        .find((q) => q.sourceId === id);
      assert.equal(
        q.american,
        americanOdds(
          captured.data.data.change.selections[0].displayOdds.american,
        ),
      );
    }
    assert.equal(app.store.sources.draftkings.updates, 2);
  } finally {
    controls.forEach((c) => c.abort());
    await app.shutdown();
  }
});
test("HTTP stream supplies snapshots to multiple viewers and a fresh snapshot on reconnect", async () => {
  const app = createApp({ ingest: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const controls = [new AbortController(), new AbortController()];
  try {
    app.store.update("draftkings", dk().normalize(), {
      receivedAt: Date.now(),
      kind: "snapshot",
    });
    const responses = await Promise.all(
      controls.map((c) => fetch(base + "/api/events", { signal: c.signal })),
    );
    for (const response of responses) {
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const text = await readFrame(response);
      assert.match(text, /event: snapshot/);
      assert.match(text, /Carolina Panthers/);
    }
    const metrics = await (await fetch(base + "/api/metrics")).json();
    assert.equal(metrics.viewers, 2);
    app.store.failure("draftkings", new Error("simulated"));
    const board = await (await fetch(base + "/api/board")).json();
    assert.equal(board.sources.draftkings.status, "stale");
    const response = await fetch(base + "/api/events", {
      signal: controls[0].signal,
    });
    const frame = await readFrame(response);
    const snapshot = JSON.parse(
      frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        .slice(6),
    );
    assert.equal(snapshot.sources.draftkings.status, "stale");
    assert.equal((await fetch(base + "/not-a-file")).status, 404);
    assert.equal(
      (await fetch(base + "/api/telemetry", { method: "POST", body: "{bad" }))
        .status,
      400,
    );
  } finally {
    for (const control of controls) control.abort();
    await app.shutdown();
  }
});
