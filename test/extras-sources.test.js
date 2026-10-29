import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { UpstreamError } from "../src/http.js";
import { makeGame } from "../src/model.js";
import { DK_EXTRA_CATEGORIES, EXTRA_KINDS, normalizeDraftKingsExtras,
  selectFanDuelExtras, normalizeFanDuelExtras, finalizeExtraRows, playerKey,
  fanDuelExtraKind } from "../src/extras/normalize.js";
import { fetchDraftKingsExtras, fetchFanDuelExtras, draftKingsExtrasUrl, fanDuelExtrasUrl } from "../src/extras/sources.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/extras-ontario.json", import.meta.url)));
const dkGame = makeGame("draftkings", "34118182", "CAR", "GB", "2026-10-30T00:15:00Z");
const fdGame = { ...dkGame, sourceId: "36215311" };
const clone = value => structuredClone(value);
const category = kind => DK_EXTRA_CATEGORIES.find(c => c.kind === kind);
const normalizeDk = (kind, data = clone(fixture.draftkings[category(kind).id]), at = 1000) => normalizeDraftKingsExtras(data, dkGame, category(kind), at);
const fdCatalog = (page = clone(fixture.fanduel.page), at = Date.now()) => selectFanDuelExtras(page, fdGame, at);
const normalizeFd = (prices = clone(fixture.fanduel.prices), catalog = fdCatalog(), at = 1000) => normalizeFanDuelExtras(catalog, prices, fdGame, at);
const response = (data, receivedAt = Date.now()) => ({ data: clone(data), receivedAt, durationMs: 1, decodedBytes: JSON.stringify(data).length });

test("recorded Ontario sources normalize all seven full-game kinds", () => {
  const dk = finalizeExtraRows(DK_EXTRA_CATEGORIES.flatMap(c => normalizeDk(c.kind).rows));
  const fd = normalizeFd();
  assert.deepEqual([...new Set(dk.rows.map(r => r.kind))].sort(), [...EXTRA_KINDS].sort());
  assert.deepEqual([...new Set(fd.rows.map(r => r.kind))].sort(), [...EXTRA_KINDS].sort());
  assert.equal(dk.rows.length, 14);
  assert.equal(finalizeExtraRows(fd.rows).rows.length, 14);
  assert.equal(fd.coverage.complete, true);
  for (const row of [...dk.rows, ...fd.rows]) {
    assert.equal(row.period, "full_game");
    assert.equal(row.rules, "including_overtime");
    assert.ok(row.decimal > 1);
  }
});

test("milestones retain inclusive thresholds and cannot become over/under quotes", () => {
  for (const kind of ["pass-yds", "rush-yds", "rec-yds", "receptions"]) {
    for (const row of normalizeDk(kind).rows) {
      assert.equal(row.thresholdOperator, "gte");
      assert.ok(Number.isInteger(row.line));
      assert.ok(!["over", "under"].includes(row.subject));
    }
    const data = clone(fixture.draftkings[category(kind).id]);
    data.selections[0].milestoneValue = 999;
    assert.throws(() => normalizeDk(kind, data), /milestone mismatch/);
    data.selections[0].label = "Over 170.5";
    assert.throws(() => normalizeDk(kind, data), /milestone contract/);
  }
});

test("FanDuel alternates read exact labelled line even when handicap is zero", () => {
  const { rows } = normalizeFd();
  for (const row of rows.filter(r => r.kind.startsWith("alt-"))) assert.notEqual(row.line, 0);
  const page = clone(fixture.fanduel.page);
  const market = Object.values(page.attachments.markets).find(m => m.marketType === "ALTERNATE_HANDICAP");
  market.runners[0].result.type = market.runners[0].result.type === "HOME" ? "AWAY" : "HOME";
  assert.throws(() => fdCatalog(page), /spread team mismatch/);
});

test("contract keys match only the same team, line, period and outcome", () => {
  const dk = normalizeDk("alt-spread").rows[0];
  const page = clone(fixture.fanduel.page);
  const market = Object.values(page.attachments.markets).find(m => m.marketType === "ALTERNATE_HANDICAP");
  market.runners[0].runnerName = `${dkGame[dk.subject].name} (${dk.line})`;
  market.runners[0].result.type = dk.subject.toUpperCase();
  const fd = normalizeFd(undefined, fdCatalog(page)).rows.find(r => r.id.endsWith(`:${market.runners[0].selectionId}`));
  assert.equal(dk.key, fd.key);
  market.runners[0].runnerName = `${dkGame[dk.subject].name} (${dk.line + 1})`;
  assert.notEqual(dk.key, normalizeFd(undefined, fdCatalog(page)).rows.find(r => r.id === fd.id).key);
});

test("only exact supported market types qualify; first/last TD and period markets stay out", () => {
  for (const type of ["FIRST_TOUCHDOWN_SCORER", "PLAYER_X_PASSING_YARDS", "PLAYER_X_ALT_PASSING_YARDS_HIGH_1ST_HALF", "ALTERNATE_TOTAL_1ST_HALF"]) assert.equal(fanDuelExtraKind(type), null);
  const data = clone(fixture.draftkings[category("td").id]);
  data.markets[0].marketType.name = "First Touchdown Scorer";
  assert.equal(normalizeDk("td", data).rows.length, 0);
  const partial = clone(fixture.draftkings[category("alt-total").id]);
  partial.markets[0].period = "1st Half";
  assert.throws(() => normalizeDk("alt-total", partial), /non-full-game/);
  partial.markets[0].period = "Full Game";
  partial.markets[0].includesOvertime = false;
  assert.throws(() => normalizeDk("alt-total", partial), /regulation-only/);
});

test("anytime TD excludes defense and no-scorer selections", () => {
  const data = clone(fixture.draftkings[category("td").id]);
  for (const label of ["GB Packers D/ST", "No Touchdown Scorer"]) {
    data.selections.push({ ...clone(data.selections[0]), id: label, label, participants: [] });
  }
  assert.equal(normalizeDk("td", data).rows.length, 2);
});

test("suspended markets and selections expose no usable prices", () => {
  const data = clone(fixture.draftkings[category("pass-yds").id]);
  data.markets[0].isSuspended = true;
  data.selections[0].displayOdds.american = "bad";
  for (const row of normalizeDk("pass-yds", data).rows) {
    assert.equal(row.suspended, true);
    assert.equal(row.american, null);
    assert.equal(row.decimal, null);
  }
  const prices = clone(fixture.fanduel.prices);
  prices[0].marketStatus = "SUSPENDED";
  delete prices[0].runnerDetails[0].winRunnerOdds;
  assert.ok(normalizeFd(prices).rows.filter(r => r.id.includes(prices[0].marketId)).every(r => r.suspended && r.american === null));
  data.markets[0].isSuspended = false;
  data.selections[0].isOpen = false;
  assert.equal(normalizeDk("pass-yds", data).rows[0].suspended, true);
});

test("invalid active prices and unknown statuses fail closed", () => {
  const data = clone(fixture.draftkings[category("td").id]);
  data.selections[0].displayOdds.american = 3;
  assert.throws(() => normalizeDk("td", data), /invalid odds/);
  data.selections[0].displayOdds.american = 200;
  assert.throws(() => normalizeDk("td", data), /odds disagree/);
  data.selections[0].status = "MYSTERY";
  assert.throws(() => normalizeDk("td", data), /unknown DraftKings/);
  const prices = clone(fixture.fanduel.prices);
  prices[0].runnerDetails[0].runnerStatus = "MYSTERY";
  assert.throws(() => normalizeFd(prices), /unknown FanDuel/);
});

test("missing FanDuel markets or active runners are incomplete, with no discovery-price fallback", () => {
  const prices = clone(fixture.fanduel.prices);
  const removed = prices.pop();
  const result = normalizeFd(prices);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.missingMarketIds, [removed.marketId]);
  assert.ok(result.rows.every(r => !r.id.includes(removed.marketId)));
  const prices2 = clone(fixture.fanduel.prices), missing = prices2[0].runnerDetails.pop();
  const result2 = normalizeFd(prices2);
  assert.equal(result2.coverage.complete, false);
  assert.ok(result2.coverage.missingRunnerIds[0].endsWith(`:${missing.selectionId}`));
  assert.ok(result2.rows.every(r => !r.id.endsWith(`:${missing.selectionId}`)));
});

test("unexpected and duplicate FanDuel market/runner prices fail closed", () => {
  const prices = clone(fixture.fanduel.prices);
  prices.push(clone(prices[0]));
  assert.throws(() => normalizeFd(prices), /duplicate FanDuel market/);
  prices.pop();
  prices[0].runnerDetails.push(clone(prices[0].runnerDetails[0]));
  assert.throws(() => normalizeFd(prices), /duplicate FanDuel runner/);
  prices[0].runnerDetails.pop();
  prices[0].runnerDetails[0].selectionId = "unknown";
  assert.throws(() => normalizeFd(prices), /unexpected.*runner/);
});

test("changed fresh FanDuel line metadata cannot reuse a stale definition", () => {
  const catalog = fdCatalog(), prices = clone(fixture.fanduel.prices);
  const target = prices.find(p => catalog.markets.get(p.marketId).runners.values().next().value.contract.kind === "alt-spread");
  target.runnerDetails[0].handicap = 999;
  assert.throws(() => normalizeFd(prices, catalog), /line changed/);
  target.runnerDetails[0].handicap = 0;
  target.runnerDetails[0].runnerName = "Carolina Panthers (+999.5)";
  assert.throws(() => normalizeFd(prices, catalog), /label changed/);
});

test("orphan DraftKings selections cannot appear in an apparently complete category", () => {
  const data = clone(fixture.draftkings[category("td").id]);
  data.selections[0].marketId = "unknown-market";
  assert.throws(() => normalizeDk("td", data), /orphan DraftKings/);
});

test("cross-event data and player label mismatches cannot enter a quote", () => {
  const data = clone(fixture.draftkings[category("td").id]);
  data.markets[0].eventId = "other";
  assert.throws(() => normalizeDk("td", data), /another event/);
  const page = clone(fixture.fanduel.page);
  page.attachments.events[fdGame.sourceId].name = "Buffalo Bills @ Green Bay Packers";
  assert.throws(() => fdCatalog(page), /teams or start/);
  const page2 = clone(fixture.fanduel.page);
  const market = Object.values(page2.attachments.markets).find(m => m.marketType.includes("ALT_PASSING_YARDS"));
  market.runners[0].runnerName = "Someone Else 150+ Yards";
  assert.throws(() => fdCatalog(page2), /player mismatch/);
});

test("player matching retains suffixes and quarantines two source identities with the same name", () => {
  assert.equal(playerKey("D.J. Moore"), playerKey("DJ Moore"));
  assert.notEqual(playerKey("Michael Pittman Jr."), playerKey("Michael Pittman"));
  const rows = normalizeDk("pass-yds").rows;
  rows[1]._playerIdentity = "another-player-id";
  const result = finalizeExtraRows(rows);
  assert.equal(result.rows.length, 0);
  assert.equal(result.quarantinedPlayers, 1);
  assert.match(result.warnings[0], /Ambiguous player/);
});

test("duplicate contracts cannot silently overwrite prices", () => {
  const rows = normalizeDk("pass-yds").rows;
  assert.throws(() => finalizeExtraRows([rows[0], { ...rows[0], id: "different-selection" }]), /duplicate outcome/);
  assert.throws(() => finalizeExtraRows([rows[0], rows[0]]), /duplicate selection/);
});

test("acquisition is fixed to Ontario and validates event IDs before building URLs", () => {
  assert.match(draftKingsExtrasUrl(dkGame, category("td")), /\/sites\/CA-ON-SB\//);
  assert.equal(new URL(fanDuelExtrasUrl(fdGame)).hostname, "sbapi.on.sportsbook.fanduel.ca");
  assert.throws(() => fanDuelExtrasUrl({ ...fdGame, sourceId: "1&region=NJ" }), /event identity/);
});

test("DraftKings fetches all seven categories sequentially and uses the oldest confirmation", async () => {
  const calls = [], times = [], result = await fetchDraftKingsExtras(dkGame, { fetcher: async (url, options) => {
    const id = new URL(url).searchParams.get("templateVars").split(",")[1];
    calls.push(id);
    assert.equal(options.headers["x-pe-loc"], "CA-ON");
    const at = 1000 + calls.length;
    times.push(at);
    return response(fixture.draftkings[id], at);
  } });
  assert.deepEqual(calls, DK_EXTRA_CATEGORIES.map(c => c.id));
  assert.equal(result.observedAt, Math.min(...times));
  assert.equal(result.rows.length, 14);
  assert.equal(result.coverage.complete, true);
  assert.ok(result.rows.every(r => !Object.hasOwn(r, "_playerIdentity")));
});

test("empty DK categories are complete source observations, not fabricated rows", async () => {
  const result = await fetchDraftKingsExtras(dkGame, { fetcher: async () => response({ markets: [], selections: [] }) });
  assert.equal(result.rows.length, 0);
  assert.equal(result.coverage.complete, true);
  assert.equal(Object.keys(result.coverage.categories).length, 7);
});

test("HTTP retry-after and cancellation propagate without partial snapshots or retries", async () => {
  const error = new UpstreamError("Rate limited", 429, 60000);
  let count = 0;
  await assert.rejects(fetchDraftKingsExtras(dkGame, { fetcher: async () => { count++; throw error; } }), e => e === error);
  assert.equal(count, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchDraftKingsExtras(dkGame, { signal: controller.signal, fetcher: async () => { throw new Error("must not fetch"); } }), /abort/i);
});

function fixtureFetcher({ page = fixture.fanduel.page, prices = fixture.fanduel.prices, calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers["X-Sportsbook-Region"], "ON");
    if (new URL(url).pathname === "/api/event-page") return response(page);
    const ids = JSON.parse(options.body).marketIds;
    assert.ok(ids.length <= 70);
    return response(prices.filter(p => ids.includes(p.marketId)));
  };
}

test("FanDuel caches lean discovery for sixty seconds while always reading fresh prices", async () => {
  const calls = [], fetcher = fixtureFetcher({ calls });
  const first = await fetchFanDuelExtras(fdGame, { fetcher });
  const second = await fetchFanDuelExtras(fdGame, { fetcher, catalog: first.catalog });
  assert.equal(first.rows.length, 14);
  assert.equal(second.rows.length, 14);
  assert.equal(calls.filter(c => c.options.method === "POST").length, 2);
  assert.equal(calls.filter(c => c.options.method !== "POST").length, 1);
  assert.equal(second.catalog, first.catalog);
  const expired = { ...first.catalog, observedAt: Date.now() - 60001 };
  await fetchFanDuelExtras(fdGame, { fetcher, catalog: expired });
  assert.equal(calls.filter(c => c.options.method !== "POST").length, 2);
});

test("partial fresh FanDuel response is never published as complete", async () => {
  const calls = [], fetcher = fixtureFetcher({ calls, prices: fixture.fanduel.prices.slice(1) });
  await assert.rejects(fetchFanDuelExtras(fdGame, { fetcher }), /incomplete/);
  assert.equal(calls.length, 2);
});

test("changed runner definitions trigger exactly one rediscovery then a fresh full read", async () => {
  const stale = fdCatalog();
  const market = stale.markets.values().next().value;
  market.runners.delete(market.runners.keys().next().value);
  const calls = [], result = await fetchFanDuelExtras(fdGame, { fetcher: fixtureFetcher({ calls }), catalog: stale });
  assert.equal(result.coverage.complete, true);
  assert.equal(calls.filter(c => c.options.method === "POST").length, 2);
  assert.equal(calls.filter(c => c.options.method !== "POST").length, 1);
});

test("FanDuel empty event catalog is a complete empty snapshot without a price request", async () => {
  const page = clone(fixture.fanduel.page);
  page.attachments.markets = {};
  const calls = [], result = await fetchFanDuelExtras(fdGame, { fetcher: fixtureFetcher({ calls, page }) });
  assert.equal(result.rows.length, 0);
  assert.equal(result.coverage.complete, true);
  assert.equal(calls.length, 1);
});

test("FanDuel larger catalogs use sequential bounded batches and oldest-batch timestamp", async () => {
  const template = clone(Object.values(fixture.fanduel.page.attachments.markets).find(m => m.marketType === "ALTERNATE_HANDICAP"));
  const page = clone(fixture.fanduel.page), prices = [];
  page.attachments.markets = {};
  for (let i = 0; i < 80; i++) {
    const market = clone(template);
    market.marketId = `801.${1000 + i}`;
    market.runners = [market.runners[0]];
    market.runners[0].selectionId = 1000 + i;
    market.runners[0].runnerName = `Carolina Panthers (+${i}.5)`;
    market.runners[0].result.type = "AWAY";
    page.attachments.markets[market.marketId] = market;
    prices.push({ marketId: market.marketId, marketStatus: "OPEN", runnerDetails: [{ selectionId: 1000 + i, runnerStatus: "ACTIVE", handicap: 0, winRunnerOdds: { americanDisplayOdds: { americanOddsInt: 100 } } }] });
  }
  let active = 0, maxActive = 0, time = 1000;
  const batches = [];
  const result = await fetchFanDuelExtras(fdGame, { fetcher: async (url, options) => {
    if (new URL(url).pathname === "/api/event-page") return response(page, 1000);
    active++; maxActive = Math.max(maxActive, active);
    const ids = JSON.parse(options.body).marketIds;
    batches.push(ids.length);
    await new Promise(resolve => setImmediate(resolve));
    active--; time += 100;
    return response(prices.filter(p => ids.includes(p.marketId)), time);
  } });
  assert.deepEqual(batches, [70, 10]);
  assert.equal(maxActive, 1);
  assert.equal(result.rows.length, 80);
  assert.equal(result.observedAt, 1100);
  assert.ok(result.rows.every(r => r.observedAt === 1100));
});
