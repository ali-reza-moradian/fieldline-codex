import test from 'node:test';
import assert from 'node:assert/strict';
import { safePreference, parseFavorites, shortcutAction, sortGames, extraOffers, extraLineLabel, HistoryLoader, historyStorageLabel, mainPriceCoverage } from '../public/ui-controls.js';
import { ExtrasPanel } from '../public/extras-panel.js';

const epoch = 1700000000000;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function timers() {
  let time = 0, id = 0; const jobs = new Map();
  return { now: () => time, jobs,
    setTimeout: (fn, delay) => { jobs.set(++id, { fn, at: time + delay }); return id; },
    clearTimeout: id => jobs.delete(id),
    async advance(ms) {
      const until = time + ms;
      for (;;) { await settle(); const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        jobs.delete(next[0]); time = next[1].at; next[1].fn();
      }
      time = until; await settle();
    }
  };
}
const source = () => ({ status: 'healthy', lastConfirmedAt: epoch, staleAfterMs: 10000 });
const sources = () => ({ draftkings: source(), fanduel: source() });
const quote = (american, extra = {}) => ({ american, observedAt: epoch, ...extra });
const row = (extra = {}) => ({ id: 'x', kind: 'alt-total', subject: 'over', name: 'Over', line: 40.5, comparable: true,
  offers: { draftkings: quote(-110), fanduel: quote(100) }, ...extra });

test('saved preferences and favorites are bounded and malformed storage fails safely', () => {
  assert.equal(safePreference('layout', 'grid'), 'grid');
  assert.equal(safePreference('scheme', '<script>'), 'light');
  assert.deepEqual([...parseFavorites('not-json')], []);
  assert.deepEqual([...parseFavorites('{"id":"one"}')], []);
  assert.deepEqual([...parseFavorites('["one",null,42,"one","two"]')], ['one', 'two']);
  assert.equal(parseFavorites(JSON.stringify(Array.from({ length: 300 }, (_, i) => `g${i}`))).size, 100);
});

test('shortcuts respect text inputs, composition, browser modifiers and repeated keys', () => {
  assert.equal(shortcutAction({ key: '/' }), 'search');
  assert.equal(shortcutAction({ key: '?' }), 'help');
  assert.equal(shortcutAction({ key: 'S' }), 'star');
  for (const key of ['ctrlKey', 'altKey', 'metaKey', 'repeat', 'isComposing', 'defaultPrevented']) assert.equal(shortcutAction({ key: 'd', [key]: true }), null);
  for (const target of [{ isContentEditable: true }, { closest: () => ({}) }]) {
    assert.equal(shortcutAction({ key: '1', target }), null);
    assert.equal(shortcutAction({ key: 'Escape', target }), 'escape');
  }
  assert.equal(shortcutAction({ key: 'Tab' }), null);
});

test('stars pin games while margin and EV sorting keep unavailable estimates last', () => {
  const games = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, live: i === 2, startsAt: new Date(epoch + i * 1000).toISOString() }));
  const analytics = new Map([['a', { bestHoldPercent: 3, bestEstimatedEvPercent: 2 }], ['b', { bestHoldPercent: -1, bestEstimatedEvPercent: 5 }], ['c', { bestHoldPercent: null, bestEstimatedEvPercent: null }]]);
  assert.deepEqual(sortGames(games, { sort: 'hold', analytics }).map(g => g.id), ['b', 'a', 'c', 'd']);
  assert.deepEqual(sortGames(games, { sort: 'ev', analytics, favorites: new Set(['d']) }).map(g => g.id), ['d', 'b', 'a', 'c']);
  assert.deepEqual(sortGames(games).map(g => g.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(games.map(g => g.id), ['a', 'b', 'c', 'd'], 'sort must not mutate live input order');
});

test('extra market best-price labels require two fresh available matching contracts', () => {
  const options = { now: epoch + 100, connected: true };
  assert.deepEqual(extraOffers(row(), sources(), options).bestBooks, ['fanduel']);
  assert.deepEqual(extraOffers(row({ offers: { draftkings: quote(100), fanduel: quote(-100) } }), sources(), options).bestBooks, ['draftkings', 'fanduel']);
  assert.deepEqual(extraOffers(row({ comparable: false }), sources(), options).bestBooks, [], 'different house protection rules cannot be ranked');
  assert.deepEqual(extraOffers(row({ comparable: undefined }), sources(), options).bestBooks, [], 'a missing comparison confirmation cannot rank offers');
  assert.deepEqual(extraOffers(row({ kind: 'pass-yds', thresholdOperator: 'gte', line: 175 }), sources(), options).bestBooks, [], 'props never inherit alternate-line ranking even if a flag is wrong');
  assert.deepEqual(extraOffers(row(), sources(), { ...options, connected: false }).bestBooks, []);
  const stale = sources(); stale.fanduel.status = 'stale';
  assert.deepEqual(extraOffers(row(), stale, options).bestBooks, []);
  assert.deepEqual(extraOffers(row(), sources(), { ...options, now: epoch + 10000 }).bestBooks, []);
  for (const invalid of [{ suspended: true }, { missing: true }, { american: 0 }, { decimal: 22 }, { observedAt: epoch - 20000 }]) {
    const result = extraOffers(row({ offers: { draftkings: quote(-110), fanduel: quote(100, invalid) } }), sources(), options);
    assert.deepEqual(result.bestBooks, []); assert.equal(result.offers.fanduel.available, false);
  }
});

const selection = { gameId: 'game-a', market: 'moneyline', side: 'away' };
function historyBody(extra = {}) { return { generatedAt: epoch + 3000, from: epoch - 1000, retentionHours: 48,
  series: [{ ...selection, book: 'draftkings', points: [{ at: epoch, american: -110, line: null }, { at: epoch + 1000, gap: true }, { at: epoch + 2000, american: 105, line: null, breakBefore: true }] }], ...extra }; }
function historyFixture(fetchFn) {
  const t = timers(); const loader = new HistoryLoader({ fetchFn, now: t.now, setTimeoutFn: t.setTimeout, clearTimeoutFn: t.clearTimeout });
  return { t, loader };
}

test('saved history is lazy, validates the exact selection and preserves real gaps', async () => {
  let calls = 0, address;
  const f = historyFixture(async url => { calls++; address = url; return { ok: true, json: async () => historyBody() }; });
  assert.equal(calls, 0); f.loader.select(selection); await settle();
  assert.equal(calls, 1); assert.match(address, /hours=48/); assert.match(address, /gameId=game-a/);
  assert.equal(f.loader.error, null); assert.equal(f.loader.data.series[0].points[1].gap, true);
  assert.equal(f.loader.data.series[0].points[2].breakBefore, true); assert.equal(f.t.jobs.size, 0); f.loader.close();
});

test('saved history rejects another selection, invalid timestamps, malformed prices and duplicate books', async () => {
  for (const mutate of [
    body => { body.series[0].side = 'home'; },
    body => { body.series[0].gameId = 'another-game'; },
    body => { body.series[0].points[2].at = epoch - 1; },
    body => { body.series[0].points[2].at = epoch + 9000; },
    body => { body.series[0].points[2].american = 99; },
    body => { body.series[0].points[2].line = '3.5'; },
    body => { body.series.push(body.series[0]); },
  ]) {
    const body = historyBody(); mutate(body);
    const f = historyFixture(async () => ({ ok: true, json: async () => body }));
    f.loader.select(selection); await settle(); assert.equal(f.loader.data, null); assert.ok(f.loader.error); f.loader.close();
  }
});

test('changing the selected chart aborts the old request and ignores late completion', async () => {
  const pending = [];
  const f = historyFixture((url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
  f.loader.select(selection); f.loader.select({ ...selection, side: 'home' });
  assert.equal(pending[0].options.signal.aborted, true);
  const current = historyBody(); current.series[0].side = 'home';
  pending[1].resolve({ ok: true, json: async () => current }); await settle();
  pending[0].resolve({ ok: true, json: async () => historyBody() }); await settle();
  assert.equal(f.loader.data.series[0].side, 'home'); assert.equal(f.t.jobs.size, 0); f.loader.close();
});

test('history refreshes coalesce while loading and cannot run more than once per second', async () => {
  let calls = 0, resolve;
  const f = historyFixture(async () => { calls++; if (calls === 1) await new Promise(r => { resolve = r; }); return { ok: true, json: async () => historyBody() }; });
  f.loader.select(selection); f.loader.refresh(); f.loader.refresh();
  assert.equal(calls, 1); resolve(); await settle();
  await f.t.advance(999); assert.equal(calls, 1);
  await f.t.advance(1); assert.equal(calls, 2);
  f.loader.refresh(); f.loader.refresh(); f.loader.close(); await f.t.advance(10000);
  assert.equal(calls, 2, 'closing a chart cancels queued history work');
});

test('history deadline also releases a fetch or body reader which ignores abort', async () => {
  for (const fetchFn of [() => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) })]) {
    const f = historyFixture(fetchFn); f.loader.select(selection); await f.t.advance(6000);
    assert.equal(f.loader.loading, false); assert.match(f.loader.error, /too long/); assert.equal(f.t.jobs.size, 0); f.loader.close();
  }
});

function extrasFixture() {
  const streams = []; let time = epoch, renders = 0;
  const panel = new ExtrasPanel({ now: () => time, onChange: () => renders++, streamFactory(options) {
    const s = { options, started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; }, resume() {} };
    streams.push(s); return s;
  } });
  return { panel, streams, advance: ms => { time += ms; }, renders: () => renders,
    snapshot(s = streams.at(-1), gameId = panel.gameId, rows = [row()]) { s.options.onEvent('snapshot', { gameId, rows, sources: sources(), revision: 1 }); } };
}

test('extra markets open only one stream and late callbacks cannot replace the next game', () => {
  const f = extrasFixture(); assert.equal(f.streams.length, 0); f.panel.open('game-a'); f.snapshot();
  assert.equal(f.panel.connected, true); f.panel.open('game-b'); assert.equal(f.streams[0].stopped, true);
  f.snapshot(f.streams[0], 'game-a'); assert.equal(f.panel.gameId, 'game-b'); assert.equal(f.panel.connected, false);
  f.snapshot(); f.streams[0].options.onDisconnect(); assert.equal(f.panel.connected, true);
  f.panel.close(); assert.equal(f.streams[1].stopped, true); f.snapshot(f.streams[1], 'game-b'); assert.equal(f.panel.gameId, null);
});

test('extra market confirmations never revive stale sources and age checks exclude silent sources', () => {
  const f = extrasFixture(); f.panel.open('game-a'); f.snapshot(); assert.equal(f.panel.fresh('fanduel'), true);
  f.advance(10000); f.panel.tick(); assert.equal(f.panel.fresh('fanduel'), false);
  f.streams[0].options.onEvent('status', { source: { ...source(), book: 'fanduel', status: 'stale' }, revision: 2 });
  f.streams[0].options.onEvent('freshness', { revision: 3, sources: { fanduel: { status: 'healthy', lastConfirmedAt: epoch + 10000 } } });
  assert.equal(f.panel.fresh('fanduel'), false); assert.equal(f.panel.sources.fanduel.status, 'stale'); f.panel.close();
});

test('extras filter locally and show at most 40 rows without adding network subscriptions', () => {
  const f = extrasFixture(); f.panel.open('game-a');
  f.snapshot(undefined, 'game-a', Array.from({ length: 135 }, (_, i) => row({ id: `r${i}`, name: `Player ${i}`, kind: i < 100 ? 'td' : 'receptions' })));
  assert.equal(f.panel.visibleRows().rows.length, 40); assert.equal(f.panel.visibleRows().pageCount, 4);
  f.panel.setFilter({ page: 3 }); assert.equal(f.panel.visibleRows().rows.length, 15);
  f.panel.setFilter({ kind: 'receptions', query: 'Player 12' });
  assert.equal(f.panel.visibleRows().total, 10); assert.equal(f.panel.page, 0); assert.equal(f.streams.length, 1); f.panel.close();
});

test('history storage messaging never promises restart persistence before a confirmed cloud save', () => {
  assert.match(historyStorageLabel(null), /memory.*restart/);
  assert.match(historyStorageLabel({ enabled: false, state: 'disabled' }), /memory/);
  assert.match(historyStorageLabel({ enabled: true, state: 'unavailable', lastSavedAt: epoch }), /unavailable/);
  assert.match(historyStorageLabel({ enabled: true, available: false, state: 'restoring', lastSavedAt: null }), /first checkpoint/);
  assert.match(historyStorageLabel({ enabled: true, available: false, state: 'connecting', lastSavedAt: epoch }), /reconnecting/);
  assert.match(historyStorageLabel({ enabled: true, available: true, state: 'ready', lastSavedAt: epoch }), /since the last checkpoint may be lost/);
});

test('inclusive player thresholds display N+ while alternate spreads keep their signed line', () => {
  for (const kind of ['pass-yds', 'rush-yds', 'rec-yds', 'receptions']) {
    const text = extraLineLabel({ kind, line: 175, thresholdOperator: 'gte' });
    assert.equal(text, '175+');
    assert.doesNotMatch(text, /over|under/i, 'an inclusive threshold must not be relabelled as an exclusive over bet');
  }
  assert.equal(extraLineLabel({ kind: 'td', line: null }), '');
  assert.equal(extraLineLabel({ kind: 'alt-total', line: 40.5 }), '40.5');
  assert.equal(extraLineLabel({ kind: 'alt-spread', line: -3.5 }), '−3.5');
  assert.equal(extraLineLabel({ kind: 'alt-spread', line: 3.5 }), '+3.5');
  assert.equal(extraLineLabel({ kind: 'alt-spread', line: 0 }), 'PK');
  assert.equal(extraLineLabel({ kind: 'pass-yds', line: '175', thresholdOperator: 'gte' }), 'Unverified line');
});

test('a suspended extra offer remains excluded across healthy freshness confirmations', () => {
  const current = row({ offers: { draftkings: quote(-110), fanduel: quote(100, { suspended: true }) } });
  const freshSources = sources();
  for (const now of [epoch + 100, epoch + 5000]) {
    freshSources.fanduel.lastConfirmedAt = now;
    const comparison = extraOffers(current, freshSources, { now, connected: true });
    assert.equal(comparison.offers.fanduel.available, false);
    assert.deepEqual(comparison.bestBooks, []);
  }
  const reopened = row({ offers: { draftkings: quote(-110), fanduel: quote(100, { observedAt: epoch + 5000 }) } });
  assert.deepEqual(extraOffers(reopened, freshSources, { now: epoch + 5000, connected: true }).bestBooks, ['fanduel']);
  assert.deepEqual(extraOffers(reopened, freshSources, { now: epoch + 15000, connected: true }).bestBooks, [], 'expired quotes cannot win even with a previously healthy source');
});


test('main price coverage distinguishes event discovery, partial prices, pauses and source expiry', () => {
  const options = { now: epoch + 100, connected: true };
  const game = { id: 'live-game', live: true, books: ['draftkings', 'fanduel'], quotes: [] };
  const full = book => ['moneyline:away', 'moneyline:home', 'spread:away', 'spread:home', 'total:over', 'total:under'].map(slot => {
    const [market, side] = slot.split(':');
    return { book, gameId: game.id, market, side, period: 'full_game', line: market === 'moneyline' ? null : 3.5, american: -110 };
  });
  game.quotes = full('fanduel');
  let coverage = mainPriceCoverage(game, sources(), options);
  assert.equal(coverage.draftkings.active, 0); assert.equal(coverage.draftkings.label, 'No current prices received');
  assert.equal(coverage.fanduel.active, 6); assert.equal(coverage.fanduel.label, '6/6 current');
  game.quotes.push(...full('draftkings').slice(0, 2));
  coverage = mainPriceCoverage(game, sources(), options);
  assert.equal(coverage.draftkings.label, '2/6 current');
  game.quotes = full('draftkings').map(q => ({ ...q, suspended: true }));
  coverage = mainPriceCoverage(game, sources(), options);
  assert.equal(coverage.draftkings.active, 0); assert.equal(coverage.draftkings.label, '6 paused');
  game.quotes = full('draftkings');
  assert.equal(mainPriceCoverage(game, sources(), { ...options, now: epoch + 10000 }).draftkings.active, 0);
  assert.equal(mainPriceCoverage(game, sources(), { ...options, connected: false }).draftkings.label, 'Prices stale; excluded');
  assert.equal(mainPriceCoverage(game, sources(), options).draftkings.active, 6, 'fresh recovery restores coverage');
});

test('main price coverage cannot count duplicate, malformed or other-contract rows as usable prices', () => {
  const q = { gameId: 'game', book: 'draftkings', market: 'moneyline', side: 'away', period: 'full_game', line: null, american: 150 };
  const game = { id: 'game', quotes: [q] }, options = { now: epoch + 100, connected: true };
  assert.equal(mainPriceCoverage(game, sources(), options).draftkings.active, 1);
  for (const patch of [{ american: 99 }, { decimal: 20 }, { missing: true }, { stale: true }, { period: 'first_half' }, { gameId: 'other' }]) {
    game.quotes = [{ ...q, ...patch }]; assert.equal(mainPriceCoverage(game, sources(), options).draftkings.active, 0);
  }
  game.quotes = [q, { ...q }];
  assert.equal(mainPriceCoverage(game, sources(), options).draftkings.active, 0);
});
