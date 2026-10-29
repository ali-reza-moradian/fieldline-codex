import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PriceHistory } from "../src/price-history.js";

const BASE = 1793300000000;
const quote = (book = "draftkings", american = -110, extra = {}) => ({
  book, gameId: "game", market: "spread", side: "away", period: "full_game", line: -3.5, american, ...extra,
});
const game = (quotes = [quote(), quote("fanduel")]) => ({ id: "game", quotes });
function fixture(options = {}) {
  let clock = BASE, next = 0;
  const jobs = new Map(), store = new EventEmitter();
  store.games = [game()];
  store.sources = Object.fromEntries(["draftkings", "fanduel"].map(book => [book, {
    book, status: "healthy", lastConfirmedAt: clock, staleAfterMs: 10000,
  }]));
  store.snapshot = () => ({ games: store.games, sources: store.sources });
  const history = new PriceHistory({ now: () => clock, schedule: fn => { jobs.set(++next, fn); return next; },
    cancel: id => jobs.delete(id), ...options });
  const drain = () => { let loops = 0; while (jobs.size) {
    assert.ok(loops++ < 1000); const [id, fn] = jobs.entries().next().value; jobs.delete(id); fn();
  } };
  const status = (book, patch = {}) => {
    store.sources[book] = { ...store.sources[book], lastConfirmedAt: clock, ...patch };
    store.emit("message", { type: "status", data: { source: { ...store.sources[book] } } });
  };
  const update = (quotes, book = "draftkings") => {
    const g = game(quotes); store.games = [g];
    store.sources[book] = { ...store.sources[book], status: "healthy", lastConfirmedAt: clock };
    store.emit("message", { type: "delta", data: { upsertGames: [g], source: { ...store.sources[book] } } });
  };
  const result = book => history.query({ gameId: "game", market: "spread", side: "away" }).series.find(s => s.book === book)?.points ?? [];
  return { history, store, jobs, drain, status, update, result, at: time => { clock = time; }, tick: (ms = 100) => { clock += ms; } };
}

test("history observation work is deferred after store fanout and timestamps are actual observations", () => {
  const f = fixture(); let delivered = 0;
  f.history.attach(f.store); f.store.on("message", () => delivered++);
  assert.equal(f.history.totalPoints, 0);
  f.tick(); f.update([quote("draftkings", -120), quote("fanduel")]);
  assert.equal(delivered, 1); assert.equal(f.history.totalPoints, 0);
  f.drain();
  assert.deepEqual(f.result("draftkings").map(p => [p.at, p.american]), [[BASE, -110], [BASE + 100, -120]]);
  f.tick(); f.status("draftkings"); f.drain();
  assert.equal(f.result("draftkings").length, 2);
  assert.ok(f.history.query().from < BASE);
  assert.equal(f.result("draftkings")[0].at, BASE); // no invented window prefix
});

test("line changes, suspension, removal and reappearance break chart continuity", () => {
  const f = fixture(); f.history.attach(f.store); f.drain();
  f.tick(); f.update([quote("draftkings", -110, { line: -4 }), quote("fanduel")]); f.drain();
  f.tick(); f.update([quote("draftkings", -110, { line: -4, suspended: true }), quote("fanduel")]); f.drain();
  f.tick(); f.update([quote("fanduel")]); f.drain();
  f.tick(); f.update([quote("draftkings", -110, { line: -4 }), quote("fanduel")]); f.drain();
  const points = f.result("draftkings");
  assert.deepEqual(points.map(p => p.american), [-110, null, -110, null, -110]);
  assert.equal(points[1].reason, "point line changed"); assert.equal(points[2].breakBefore, true);
  assert.equal(points[3].suspended, true); assert.equal(points[4].breakBefore, true);
  f.tick(); f.update([quote("fanduel")]); f.drain();
  assert.equal(f.result("draftkings").at(-1).reason, "quote removed");
});

test("source failure and idle expiry produce gaps; recovery starts from fresh baseline", () => {
  const f = fixture(); f.history.attach(f.store); f.drain();
  f.tick(); f.status("draftkings", { status: "stale" }); f.drain();
  assert.equal(f.result("draftkings").at(-1).gap, true);
  assert.equal(f.result("fanduel").length, 1);
  f.tick(); f.status("draftkings", { status: "healthy" }); f.drain();
  assert.equal(f.result("draftkings").at(-1).breakBefore, true);
  f.tick(10000);
  assert.equal(f.result("draftkings").at(-1).gap, true);
  assert.equal(f.result("fanduel").at(-1).gap, true);
  const oldCount = f.result("draftkings").length;
  f.tick(1000); f.result("draftkings"); assert.equal(f.result("draftkings").length, oldCount);
  f.status("draftkings"); f.drain();
  assert.equal(f.result("draftkings").at(-1).at, BASE + 11200);
  assert.equal(f.result("draftkings").at(-1).breakBefore, true);
});

test("lost queue events insert a gap and recapture latest immutable board; live fanout still receives every event", () => {
  const f = fixture({ maxPending: 2 }); f.history.attach(f.store); f.drain();
  let delivered = 0; f.store.on("message", () => delivered++);
  for (const american of [-120, -130, -140]) { f.tick(); f.update([quote("draftkings", american), quote("fanduel")]); }
  assert.equal(delivered, 3); assert.equal(f.history.totalPoints, 2);
  f.drain(); const points = f.result("draftkings");
  assert.deepEqual(points.map(p => p.american), [-110, null, -140]);
  assert.equal(points[1].reason, "history queue overflow");
  assert.equal(points[2].breakBefore, true); assert.equal(f.history.limits().queueOverflows, 1);
});

test("history obeys per-series and total capacity and query suffix preserves interior boundaries", () => {
  const f = fixture({ maxPointsPerSeries: 4, maxTotalPoints: 6 }); f.history.attach(f.store); f.drain();
  f.tick(); f.update([quote("draftkings", -120), quote("fanduel")]); f.drain();
  f.tick(); f.status("draftkings", { status: "stale" }); f.drain();
  f.tick(); f.status("draftkings", { status: "healthy" }); f.drain();
  f.tick(); f.update([quote("draftkings", -130), quote("fanduel")]); f.drain();
  const data = f.history.query({ maxPoints: 3 });
  const points = data.series.find(s => s.book === "draftkings").points;
  assert.equal(data.limits.truncated, true); assert.equal(points.length, 3);
  assert.equal(points[0].gap, true); assert.equal(points[1].breakBefore, true);
  assert.ok(f.history.totalPoints <= 6); assert.ok(f.result("draftkings").length <= 4);
  const bounded = fixture({ maxSeries: 1, maxTotalPoints: 2 }); bounded.history.attach(bounded.store); bounded.drain();
  assert.equal(bounded.history.series.size, 1); assert.ok(bounded.history.limits().evictedSeries > 0);
});

test("retention windows never manufacture a current value or join across omitted history", () => {
  const f = fixture({ retentionMs: 60000 }); f.history.attach(f.store); f.drain();
  f.tick(61000); const result = f.history.query();
  assert.equal(result.retentionHours, 1 / 60);
  assert.ok(result.series.every(s => s.points.every(p => p.gap))); // stale gap only, old price expired
  f.tick(61000); assert.equal(f.history.query().series.length, 0);
});

test("safe restoration merges older points, never overwrites live observations or restores eligibility", () => {
  const prior = fixture(); prior.history.attach(prior.store); prior.drain();
  prior.tick(); prior.update([quote("draftkings", -120), quote("fanduel")]); prior.drain();
  const checkpoint = prior.history.serialize();
  assert.equal(checkpoint.sources, undefined);
  const f = fixture(); f.at(BASE + 200); f.history.load(JSON.stringify(checkpoint));
  assert.ok([...f.history.series.values()].every(entry => entry.active === false));
  f.history.attach(f.store); f.drain();
  assert.equal(f.result("draftkings").at(-1).at, BASE + 200);
  assert.equal(f.result("draftkings").at(-1).breakBefore, true);
  const current = fixture(); current.at(BASE + 300); current.history.attach(current.store); current.drain();
  current.history.load(checkpoint);
  assert.deepEqual(current.result("draftkings").map(p => p.american), [-110, -120, -110]);
  assert.equal(current.result("draftkings").at(-1).breakBefore, true);
  current.history.load(checkpoint); assert.equal(current.result("draftkings").length, 3);
});

test("checkpoint validation rejects future, inconsistent and out-of-order points and breaks next segment", () => {
  const f = fixture(); f.at(BASE + 1000);
  const raw = { schema: 1, series: [{ ...quote(), points: [
    { at: BASE, american: -110, decimal: 1 + 100 / 110, line: -3.5 },
    { at: BASE + 2000, american: -110, decimal: 1 + 100 / 110, line: -3.5 },
    { at: BASE + 100, american: -120, decimal: 99, line: -3.5 },
    { at: BASE + 200, american: -120, decimal: 1 + 100 / 120, line: -3.5 },
    { at: BASE + 100, american: -130, decimal: 1 + 100 / 130, line: -3.5 },
    { at: BASE + 300, american: -130, decimal: 1 + 100 / 130, line: -3.5 },
  ] }] };
  const stats = f.history.load(raw); assert.equal(stats.rejectedPoints, 3);
  const points = f.result("draftkings"); assert.equal(points.length, 3);
  assert.equal(points[1].breakBefore, true); assert.equal(points[2].breakBefore, true);
  const previous = f.history.totalPoints;
  assert.throws(() => f.history.load({ schema: 999, series: [] }), /Invalid/);
  assert.equal(f.history.totalPoints, previous);
  points[0].american = 900; assert.equal(f.result("draftkings")[0].american, -110);
});

test("detaching cancels queued work and preserves the explicit disconnected boundary", () => {
  const f = fixture(), detach = f.history.attach(f.store); f.drain();
  f.tick(); f.update([quote("draftkings", -120), quote("fanduel")]); detach();
  assert.equal(f.jobs.size, 0); assert.equal(f.store.listenerCount("message"), 0);
  assert.equal(f.history.pending.length, 0);
  assert.equal(f.result("draftkings").at(-1).reason, "collector detached");
  detach(); // idempotent
});

test("clock rollback cannot create backward observations or a joined segment", () => {
  const f = fixture(); f.history.attach(f.store); f.drain();
  f.tick(); f.update([quote("draftkings", -120), quote("fanduel")]); f.drain();
  f.at(BASE - 100); f.update([quote("draftkings", -130), quote("fanduel")]); f.drain();
  f.at(BASE + 200); f.update([quote("draftkings", -140), quote("fanduel")]); f.drain();
  const points = f.result("draftkings");
  assert.deepEqual(points.map(p => p.american), [-110, -120, -140]);
  assert.equal(points[2].breakBefore, true); assert.equal(f.history.limits().clockRollbacks, 1);
});

test("bounded query draining never backdates a gap ahead of still pending observations", () => {
  const f = fixture({ batchSize: 1 }); f.history.attach(f.store); f.drain();
  f.tick(); f.update([quote("draftkings", -120), quote("fanduel")]);
  f.tick(); f.update([quote("draftkings", -130), quote("fanduel")]);
  f.tick(20000); const partial = f.history.query(); assert.equal(partial.limits.pendingEvents, 1);
  f.drain(); const points = f.result("draftkings");
  assert.ok(points.every((p, i) => !i || p.at >= points[i - 1].at));
  assert.equal(points.at(-1).gap, true);
});

test("invalid query inputs and mismatched game identity cannot create chart observations", () => {
  const f = fixture(); f.store.games = [game([quote("draftkings", -110, { gameId: "wrong" })])];
  f.history.attach(f.store); f.drain(); assert.equal(f.history.query().series.length, 0);
  for (const args of [{ hours: -1 }, { hours: Infinity }, { maxPoints: 0 }, { market: "toString" }, { gameId: "" }])
    assert.throws(() => f.history.query(args));
});

test("late restoration evicts oldest observations before newer live history at either capacity bound", () => {
  for (const capacity of [{ maxSeries: 2, maxTotalPoints: 100 }, { maxSeries: 10, maxTotalPoints: 3 }]) {
    for (const descending of [false, true]) for (const incremental of [false, true]) {
      const f = fixture(capacity); f.store.games = [game([quote()])]; f.at(BASE + 1000);
      f.history.attach(f.store); f.drain();
      let rows = [100, 300].map(offset => ({ ...quote(), gameId: `restored-${offset}`, points: [offset, offset + 100].map(ms => ({
        at: BASE + ms, american: -120, decimal: 1 + 100 / 120, line: -3.5,
      })) }));
      if (descending) rows.reverse();
      if (incremental) for (const row of rows) f.history.load({ schema: 1, series: [row] });
      else f.history.load({ schema: 1, series: rows });
      const retained = [...f.history.series.values()];
      assert.deepEqual(retained.map(s => s.gameId), ["restored-300", "game"]);
      assert.equal(retained[1].active, true); assert.equal(retained[1].points[0].at, BASE + 1000);
      assert.equal(retained[0].active, false); assert.equal(f.history.totalPoints, 3);
      assert.equal(f.history.limits().evictedSeries, 1);
    }
  }
});
