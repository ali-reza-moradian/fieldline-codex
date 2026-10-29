import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { OddsStore } from '../src/store.js';
import { makeGame, makeQuote } from '../src/model.js';

function dataset() {
  const nfl = makeGame('fanduel', 'n1', 'Carolina Panthers', 'Green Bay Packers', '2026-10-30T00:15:00Z');
  const college = { ...nfl, id: 'ncaaf:2026-10-29:FAU:UNT', sourceId: 'c1', league: 'ncaaf',
    away: { id: 'FAU', name: 'Florida Atlantic' }, home: { id: 'UNT', name: 'North Texas' } };
  const lease = { status: 'healthy', lastConfirmedAt: Date.now(), lastDataAt: Date.now(), lastChangeAt: null,
    staleAfterMs: 10000, coverage: { requested: 1, returned: 1, missingIds: [] } };
  return { games: [nfl, college], quotes: [makeQuote(nfl, 'moneyline', 'away', null, 150, 'nq'), makeQuote(college, 'moneyline', 'away', null, 200, 'cq')], warnings: [],
    source: { status: 'healthy', leagues: { nfl: { ...lease }, ncaaf: { ...lease }, cfl: { ...lease, status: 'connecting', lastConfirmedAt: null } } } };
}
const timing = () => ({ receivedAt: Date.now(), kind: 'poll', pollMs: 250 });
async function waitFor(fn) { for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await delay(5); } throw Error('Local stream timeout'); }
async function setup() {
  const app = createApp({ ingest: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, close: () => app.shutdown() };
}
test('HTTP and SSE scope college and NFL independently, including failure leases and removal', async () => {
  const f = await setup(), streams = [];
  try {
    const data = dataset(); f.app.store.update('fanduel', data, timing());
    for (const league of ['nfl', 'ncaaf']) {
      const body = await (await fetch(f.base + '/api/board?league=' + league)).json();
      assert.equal(body.games.length, 1); assert.equal(body.games[0].league, league);
      assert.equal(body.sources.fanduel.games, 1); assert.equal(body.sources.fanduel.quotes, 1);
      const controller = new AbortController(), frames = [];
      const response = await fetch(f.base + '/api/events?league=' + league, { signal: controller.signal });
      const done = (async () => {
        let pending = ''; const decoder = new TextDecoder();
        try { for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true }); const parts = pending.split('\n\n'); pending = parts.pop();
          for (const part of parts) { const raw = /^data: (.+)$/m.exec(part)?.[1]; if (raw) frames.push({ type: /^event: (.+)$/m.exec(part)?.[1], data: JSON.parse(raw) }); }
        } } catch (e) { if (!controller.signal.aborted) throw e; }
      })();
      streams.push({ league, controller, frames, done });
      await waitFor(() => frames.some(r => r.type === 'snapshot'));
    }
    const next = structuredClone(data); next.quotes[1].american = 220; next.quotes[1].decimal = 3.2;
    next.source.leagues.ncaaf.status = 'stale'; next.source.status = 'stale';
    next.source.leagues.ncaaf.error = 'College price request failed';
    f.app.store.update('fanduel', next, timing());
    const college = streams[1], nfl = streams[0];
    const change = await waitFor(() => college.frames.find(r => r.type === 'delta'));
    assert.equal(change.data.source.status, 'stale'); assert.equal(change.data.upsertGames[0].quotes[0].american, 220);
    await delay(30);
    assert.ok(nfl.frames.every(r => r.type !== 'delta'));
    const nflBoard = await (await fetch(f.base + '/api/board')).json();
    assert.equal(nflBoard.sources.fanduel.status, 'healthy');
    assert.equal(nflBoard.sources.fanduel.error, null);
    const remove = structuredClone(next); remove.games = remove.games.filter(g => g.league === 'nfl'); remove.quotes = remove.quotes.filter(q => q.id === 'fanduel:nq');
    f.app.store.update('fanduel', remove, timing());
    await waitFor(() => college.frames.some(r => r.data.removeGameIds?.includes(data.games[1].id)));
    assert.ok(nfl.frames.every(r => !(r.data.removeGameIds?.length)));
    assert.equal((await fetch(f.base + '/api/board?league=wrong')).status, 400);
    assert.equal((await fetch(f.base + '/api/events?league=wrong')).status, 400);
    assert.equal((await fetch(f.base + '/api/extras/events?gameId=' + encodeURIComponent(data.games[1].id))).status, 404);
  } finally { for (const s of streams) s.controller.abort(); await Promise.all(streams.map(s => s.done)); await f.close(); }
});

test('compressed boards preserve every quote and cannot be reused as a stale cached snapshot', async () => {
  const f = await setup();
  try {
    f.app.store.update('fanduel', dataset(), timing());
    const response = await fetch(f.base + '/api/board', { headers: { 'Accept-Encoding': 'gzip' } });
    const body = await response.json(); assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(response.headers.get('etag'), null);
    assert.equal(body.games[0].quotes[0].american, 150);
    assert.ok(Number(response.headers.get('content-length')) < Buffer.byteLength(JSON.stringify(body)));
    const next = dataset(); next.quotes[0].american = 175; next.quotes[0].decimal = 2.75;
    f.app.store.update('fanduel', next, timing());
    assert.equal((await (await fetch(f.base + '/api/board')).json()).games[0].quotes[0].american, 175);
    const staticResponse = await fetch(f.base + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.match(await staticResponse.text(), /selectLeague/);
    assert.equal(staticResponse.headers.get('content-encoding'), 'gzip');
    const unchanged = await fetch(f.base + '/app.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': staticResponse.headers.get('etag') } });
    assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
    const plain = await fetch(f.base + '/app.js', { headers: { 'Accept-Encoding': 'gzip;q=0' } });
    assert.equal(plain.headers.get('content-encoding'), null); assert.match(await plain.text(), /selectLeague/);
    for (const path of ['/leagues.js', '/college-teams.js']) assert.equal((await fetch(f.base + path)).status, 200);
  } finally { await f.close(); }
});

test('quiet verification avoids rebuilding boards but price, settlement and removal changes do not', () => {
  const store = new OddsStore(); let builds = 0;
  const build = store.buildBoard.bind(store); store.buildBoard = () => { builds++; return build(); };
  const data = dataset(); store.update('fanduel', data, timing());
  const board = store.boards; store.update('fanduel', structuredClone(data), timing());
  assert.equal(builds, 1); assert.equal(store.boards, board);
  const changed = structuredClone(data); changed.quotes[0].settlement = 'regulation';
  store.update('fanduel', changed, timing()); assert.equal(builds, 2);
  store.update('fanduel', { games: [], quotes: [], warnings: [] }, timing());
  assert.equal(builds, 3); assert.equal(store.boards.size, 0);
});

test('a complete college snapshot larger than 256KiB is delivered with a bounded queue', async () => {
  const f = await setup(); const controller = new AbortController(); let done;
  try {
    const data = dataset(), prototype = data.games[1]; data.games = []; data.quotes = [];
    for (let i = 0; i < 300; i++) {
      const game = { ...prototype, id: `ncaaf:2026-10-29:away${i}:home${i}`, sourceId: `game${i}` };
      data.games.push(game);
      for (const [market, sides] of [['moneyline',['away','home']],['spread',['away','home']],['total',['over','under']]])
        for (const side of sides) data.quotes.push(makeQuote(game, market, side, market === 'moneyline' ? null : 3.5, -110, `${i}-${market}-${side}`));
    }
    f.app.store.update('fanduel', data, timing());
    let serverResponse;
    f.app.server.on('request', (req, res) => { if (req.url.startsWith('/api/events')) serverResponse = res; });
    const response = await fetch(f.base + '/api/events?league=ncaaf', { signal: controller.signal });
    const frames = []; let buffer = ''; const decoder = new TextDecoder();
    done = (async () => { try { for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }); const parts = buffer.split('\n\n'); buffer = parts.pop();
      for (const part of parts) { const body = /^data: (.+)$/m.exec(part)?.[1]; if (body) frames.push(JSON.parse(body)); }
    } } catch (e) { if (!controller.signal.aborted) throw e; } })();
    const snapshot = await waitFor(() => frames.find(r => r.games));
    assert.equal(snapshot.games.length, 300); assert.equal(snapshot.games.flatMap(g => g.quotes).length, 1800);
    assert.ok(serverResponse.fieldlineBufferLimit > 256 * 1024);
    assert.ok(serverResponse.fieldlineBufferLimit <= 1024 * 1024);
    Object.defineProperty(serverResponse, 'writableLength', { configurable: true, get: () => serverResponse.fieldlineBufferLimit });
    f.app.store.failure('fanduel', Error('test disconnection'));
    await waitFor(() => serverResponse.destroyed);
  } finally { controller.abort(); await done; await f.close(); }
});
