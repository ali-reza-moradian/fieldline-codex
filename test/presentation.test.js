import test from "node:test";
import assert from "node:assert/strict";
import { formatOdds, safeView, safeFormat, sourceFresh, quoteChange, SessionHistory, historySegments } from "../public/presentation.js";

const quote = (american = -110, line = -3.5, patch = {}) => ({
  id: "fanduel:1", sourceId: "1", gameId: "game", book: "fanduel", period: "full_game",
  market: "spread", side: "away", american, line, suspended: false, ...patch,
});
const game = quotes => ({ id: "game", away: { id: "CAR" }, home: { id: "GB" }, quotes });

test("odds display and shareable preferences reject invalid values", () => {
  assert.equal(formatOdds(-110), "−110"); assert.equal(formatOdds(125), "+125");
  assert.equal(formatOdds(-110, "decimal"), "1.909"); assert.equal(formatOdds(125, "decimal"), "2.250");
  for (const v of [null, undefined, NaN, Infinity, 0, 99]) assert.equal(formatOdds(v), "—");
  assert.equal(safeView("fanduel"), "fanduel"); assert.equal(safeView("unknown"), "best");
  assert.equal(safeFormat("decimal"), "decimal"); assert.equal(safeFormat("unknown"), "american");
});

test("source eligibility tolerates small clock skew but rejects expired, invalid and disconnected confirmations", () => {
  const source = { status: "healthy", lastConfirmedAt: 1000, staleAfterMs: 10000 };
  const options = { connected: true, now: 1050, clockUncertaintyMs: 40 };
  assert.equal(sourceFresh(source, options), true);
  assert.equal(sourceFresh({ ...source, lastConfirmedAt: 1080 }, options), true);
  for (const lastConfirmedAt of [null, undefined, NaN, Infinity, 3000])
    assert.equal(sourceFresh({ ...source, lastConfirmedAt }, options), false);
  assert.equal(sourceFresh(source, { ...options, now: 11000 }), false);
  assert.equal(sourceFresh(source, { ...options, connected: false }), false);
  assert.equal(sourceFresh({ ...source, status: "stale" }, options), false);
});

test("movement follows payout for negative and cross-sign odds, with no false -100/+100 arrow", () => {
  for (const [before, after, direction] of [[-120, -110, 1], [-110, -120, -1], [-110, 100, 1], [100, -110, -1], [150, 140, -1]]) {
    const move = quoteChange(quote(before), quote(after));
    assert.equal(move.kind, "price"); assert.equal(move.direction, direction);
  }
  assert.equal(quoteChange(quote(-100), quote(100)), null);
  assert.equal(quoteChange(null, quote(110)), null);
});

test("line and suspension changes cannot be presented as an up/down price recommendation", () => {
  const line = quoteChange(quote(-110, -3.5), quote(120, -4));
  assert.equal(line.kind, "line"); assert.equal(line.direction, 0); assert.equal(line.before.line, -3.5);
  const suspended = quoteChange(quote(-110), quote(120, -3.5, { suspended: true }));
  assert.equal(suspended.kind, "availability"); assert.equal(suspended.direction, 0);
  const both = quoteChange(quote(-110), quote(null, -4, { suspended: true }));
  assert.equal(both.kind, "line"); assert.equal(both.availabilityChanged, true); assert.equal(both.direction, 0);
});

test("initial and reconnect snapshots are baselines, while provider ID changes preserve observed line moves", () => {
  const h = new SessionHistory();
  h.recordGames([game([quote(-110, -3.5, { previousAmerican: -120 })])], { at: 100, baseline: true, replaceAll: true });
  assert.equal(h.recent.length, 0);
  h.recordGames([game([quote(-105, -4, { id: "fanduel:new", sourceId: "new" })])], { at: 200 });
  assert.equal(h.recent.length, 1); assert.equal(h.recent[0].kind, "line");
  h.disconnect(250);
  h.recordGames([game([quote(120, -4)])], { at: 300, baseline: true, replaceAll: true });
  assert.equal(h.recent.length, 1, "a reconnect difference was not witnessed as a movement");
  assert.equal(h.changeFor(quote(120, -4), 301), null);
  const segments = historySegments(h.forSelection("game", "spread", "away", 301)[0].points);
  assert.equal(segments.length, 3); assert.deepEqual(segments.map(s => s[0].at), [100, 200, 300]);
});

test("history stays bounded, ignores repeat values, expires movement cues, and breaks on missing quotes", () => {
  const h = new SessionHistory({ maxPoints: 3, maxMoves: 2, maxSeries: 2, maxAgeMs: 20000 });
  h.recordGames([game([quote(-110)])], { at: 100, baseline: true });
  h.recordGames([game([quote(-110)])], { at: 200 });
  assert.equal(h.forSelection("game", "spread", "away", 200)[0].points.length, 1);
  for (let i = 1; i <= 5; i++) h.recordGames([game([quote(110 + i)])], { at: 200 + i });
  assert.equal(h.recent.length, 2); assert.equal(h.forSelection("game", "spread", "away", 206)[0].points.length, 3);
  assert.equal(h.changeFor(quote(115), 205).direction, 1); assert.equal(h.changeFor(quote(115), 8205), null);
  h.recordGames([game([])], { at: 300 });
  assert.equal(historySegments(h.forSelection("game", "spread", "away", 301)[0].points).at(-1).at(-1).at, 205);
  h.recordGames([game([quote(120, -3.5, { side: "home" }), quote(130, -3.5, { side: "over" }), quote(140, -3.5, { side: "under" })])], { at: 400 });
  assert.ok(h.series.size <= 2); assert.ok(h.current.size <= 2);
  assert.equal(h.forSelection("game", "spread", "under", 20401)[0].points.length, 0);
});

test("one stale source gets a gap and a new baseline without interrupting the other book", () => {
  const h = new SessionHistory();
  const fd = quote(-110), dk = quote(-115, -3.5, { book: "draftkings", id: "draftkings:1" });
  h.recordGames([game([fd, dk])], { at: 100, baseline: true });
  h.disconnect(150, "fanduel"); h.disconnect(160, "fanduel");
  assert.equal(h.hasCurrentBook("draftkings"), true); assert.equal(h.hasCurrentBook("fanduel"), false);
  h.recordGames([game([quote(120), dk])], { at: 200, baseline: true, book: "fanduel" });
  assert.equal(h.recent.length, 0); assert.equal(h.hasCurrentBook("draftkings"), true);
  const series = h.forSelection("game", "spread", "away", 201);
  assert.equal(historySegments(series.find(s => s.book === "fanduel").points).length, 2);
  assert.equal(series.find(s => s.book === "fanduel").points.length, 3, "repeated stale status does not add repeated gaps");
  assert.equal(series.find(s => s.book === "draftkings").points.length, 1);
});

test("another book's full-game delta cannot reintroduce a stale book's comparison baseline", () => {
  const h = new SessionHistory();
  const dk = quote(-110, -3.5, { book: "draftkings" }), fd = quote(-115);
  h.recordGames([game([dk, fd])], { at: 100, baseline: true });
  h.disconnect(150, "draftkings");
  h.recordGames([game([dk, quote(-120)])], { at: 200, book: "fanduel" });
  assert.equal(h.hasCurrentBook("draftkings"), false);
  assert.equal(h.recent.length, 1); assert.equal(h.recent[0].book, "fanduel");
  h.recordGames([game([quote(130, -4, { book: "draftkings" }), quote(-120)])], { at: 300, baseline: true, book: "draftkings" });
  assert.equal(h.recent.length, 1, "recovered DK prices are a new baseline, not an observed move");
  const dkSeries = h.forSelection("game", "spread", "away", 301).find(s => s.book === "draftkings");
  assert.deepEqual(historySegments(dkSeries.points).map(s => s[0].at), [100, 300]);
});
