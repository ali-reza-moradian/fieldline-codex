import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PriceHistory } from "../src/price-history.js";
import { sourceForLeague, leagueSnapshot, leagueFrame } from "../src/league-view.js";
import { isSourceFresh } from "../src/analytics.js";

const BASE = 1793300000000;
const ids = { nfl: "2026-10-29:CAR:GB", ncaaf: "ncaaf:2026-10-29:FAU:UNT", cfl: "cfl:2026-10-31:WPG:TOR" };
const game = (league, american = -110) => ({ id: ids[league], league, books: ["fanduel"],
  quotes: [{ id: league, sourceId: league, book: "fanduel", gameId: ids[league], period: "full_game",
    market: "moneyline", side: "home", line: null, american }] });
const lease = (at, patch = {}) => ({ status: "healthy", lastConfirmedAt: at, lastDataAt: at,
  staleAfterMs: 10000, coverage: { requested: 3, returned: 3, missingIds: [] }, ...patch });
function fixture() {
  let now = BASE, id = 0;
  const jobs = new Map(), store = new EventEmitter();
  store.games = [game("nfl"), game("ncaaf"), game("cfl")];
  store.sources = { fanduel: { book: "fanduel", region: "Ontario", ...lease(now),
    status: "stale", leagues: { nfl: lease(now), ncaaf: lease(now), cfl: lease(now, { status: "stale" }) } } };
  store.snapshot = () => ({ games: store.games, sources: store.sources });
  const history = new PriceHistory({ now: () => now,
    schedule: fn => { jobs.set(++id, fn); return id; }, cancel: key => jobs.delete(key) });
  const drain = () => { while (jobs.size) { const [key, fn] = jobs.entries().next().value; jobs.delete(key); fn(); } };
  const status = (league, patch = {}) => {
    store.sources.fanduel = { ...store.sources.fanduel, lastConfirmedAt: now,
      leagues: { ...store.sources.fanduel.leagues, [league]: { ...store.sources.fanduel.leagues[league], ...patch } } };
    store.emit("message", { type: "status", data: { source: store.sources.fanduel } });
  };
  const points = league => history.query({ gameId: ids[league] }).series[0]?.points ?? [];
  history.attach(store); drain();
  return { history, store, status, points, drain, tick: ms => { now += ms; }, now: () => now };
}

test("a failed CFL lease does not gap healthy NFL or college history under a conservative aggregate", () => {
  const f = fixture();
  assert.equal(f.points("nfl").length, 1);
  assert.equal(f.points("ncaaf").length, 1);
  assert.equal(f.points("cfl").length, 0);
  f.tick(250); f.status("nfl", { lastConfirmedAt: f.now() }); f.drain();
  assert.equal(f.points("nfl").length, 1, "unchanged healthy values are not fabricated history points");
  assert.equal(f.points("ncaaf").length, 1);
  f.history.detach();
});

test("college failure and recovery create only a college gap and fresh segment", () => {
  const f = fixture();
  f.tick(100); f.status("ncaaf", { status: "stale" }); f.drain();
  assert.equal(f.points("ncaaf").at(-1).gap, true);
  assert.equal(f.points("nfl").length, 1);
  f.tick(100); f.status("nfl", { lastConfirmedAt: f.now() }); f.drain();
  assert.equal(f.points("ncaaf").length, 2, "an NFL verification cannot reopen college history");
  f.tick(100); f.status("ncaaf", { status: "healthy", lastConfirmedAt: f.now() }); f.drain();
  assert.equal(f.points("ncaaf").at(-1).breakBefore, true);
  assert.equal(f.points("ncaaf").at(-1).at, f.now());
  assert.equal(f.points("nfl").length, 1);
  f.history.detach();
});

test("old college clocks and incomplete college coverage stay ineligible despite fresh NFL timestamps", () => {
  const f = fixture();
  f.tick(10001); f.status("nfl", { lastConfirmedAt: f.now() }); f.drain();
  assert.equal(f.points("ncaaf").at(-1).gap, true);
  assert.equal(f.points("nfl").at(-1).american, -110);
  f.status("ncaaf", { lastConfirmedAt: f.now(), coverage: { requested: 3, returned: 2, missingIds: ["missing"] } }); f.drain();
  assert.equal(f.points("ncaaf").at(-1).gap, true);
  f.tick(10); f.status("ncaaf", { lastConfirmedAt: f.now(), coverage: { requested: 3, returned: 3, missingIds: [] } }); f.drain();
  assert.equal(f.points("ncaaf").at(-1).american, -110);
  assert.equal(f.points("ncaaf").at(-1).breakBefore, true);
  f.history.detach();
});

test("restored college history cannot borrow NFL eligibility before a college baseline", () => {
  const f = fixture(), checkpoint = f.history.serialize();
  f.history.detach();
  const restored = new PriceHistory({ now: f.now }); restored.load(checkpoint);
  assert.ok([...restored.series.values()].every(row => !row.active));
  const source = { ...f.store.sources.fanduel, status: "healthy", lastConfirmedAt: f.now(),
    leagues: { nfl: lease(f.now()) } };
  assert.equal(isSourceFresh(sourceForLeague(source, "ncaaf"), f.now()), false);
  restored.process({ type: "snapshot", data: { games: [game("ncaaf")], sources: { fanduel: source } }, at: f.now() });
  assert.ok([...restored.series.values()].filter(row => row.gameId === ids.ncaaf).every(row => !row.active));
});

test("league snapshots and delta removals preserve school/game isolation and source leases", () => {
  const f = fixture();
  const selected = leagueSnapshot(f.store.snapshot(), "ncaaf");
  assert.deepEqual(selected.games.map(row => row.id), [ids.ncaaf]);
  assert.equal(selected.sources.fanduel.status, "healthy");
  assert.equal(selected.sources.fanduel.games, 1);
  const frame = leagueFrame("delta", { revision: 4, sentAt: BASE, upsertGames: [game("nfl"), game("ncaaf")],
    removeGameIds: [ids.nfl, ids.ncaaf, ids.cfl], source: f.store.sources.fanduel }, "ncaaf", {
      boards: new Map(f.store.games.map(row => [row.id, row])),
    });
  assert.deepEqual(frame.data.upsertGames.map(row => row.id), [ids.ncaaf]);
  assert.deepEqual(frame.data.removeGameIds, [ids.ncaaf]);
  assert.equal(frame.data.source.status, "healthy");
  f.history.detach();
});
