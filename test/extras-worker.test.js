import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtrasWorker } from '../src/extras-worker.js';
import { UpstreamError } from '../src/http.js';
import { readFile } from 'node:fs/promises';
import { makeGame } from '../src/model.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
  let now = 1000, timerId = 0;
  const pending = [], sent = [], timers = new Map(), calls = [];
  const fetcher = book => (game, options) => {
    calls.push({ book, game, options });
    return new Promise((resolve, reject) => pending.push({ book, game, options, resolve, reject }));
  };
  const worker = new ExtrasWorker({ send: message => sent.push(message),
    fetchers: { draftkings: fetcher('draftkings'), fanduel: fetcher('fanduel') }, now: () => now,
    schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now+delay }); return id; }, cancel: id => timers.delete(id) });
  const advance = async ms => {
    now += ms;
    for (let round = 0; round < 10; round++) {
      const due = [...timers].filter(([, t]) => t.at <= now);
      if (!due.length) break;
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      await flush();
    }
  };
  const watch = (id, generation = 1, books = ['draftkings', 'fanduel'], extra = {}) => worker.command({ type: 'watch', gameId: id, generation,
    sourceGames: Object.fromEntries(books.map(book => [book, { id, sourceId: `${id}-${book}` }])), ...extra });
  return { worker, watch, calls, sent, pending, timers, advance, now: () => now };
}
const data = (job, overrides = {}) => ({ book: job.book, gameId: job.game.id, observedAt: 1000, region: 'Ontario', rows: [], coverage: { complete: true }, ...overrides });

test('each book has one global request across games and repeated same-generation watches', async () => {
  const h = harness();
  h.watch('A'); h.watch('A'); h.watch('B'); h.watch('C'); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.worker.games.size, 2);
  assert.deepEqual(h.calls.map(c => c.game.id), ['A', 'A']);
  h.pending[0].resolve(data(h.pending[0])); await flush();
  assert.equal(h.calls.length, 3); assert.equal(h.calls.at(-1).game.id, 'B');
  assert.equal(h.calls.at(-1).book, 'draftkings');
  assert.equal(h.worker.running.size, 2);
  h.worker.stop();
});

test('a failed book does not hold up the other book and catalog stays private in the worker', async () => {
  const h = harness(); h.watch('A'); await flush();
  const dk = h.pending.find(p => p.book === 'draftkings'), fd = h.pending.find(p => p.book === 'fanduel');
  dk.reject(new Error('Unavailable'));
  const catalog = { markets: new Map([['id', {}]]) };
  fd.resolve(data(fd, { catalog })); await flush();
  assert.equal(h.sent.find(m => m.book === 'draftkings').type, 'failure');
  assert.equal(h.sent.find(m => m.book === 'fanduel').type, 'result');
  assert.equal(h.sent.find(m => m.type === 'result').data.catalog, undefined);
  await h.advance(15000);
  assert.equal(h.calls.filter(c => c.book === 'fanduel').at(-1).options.catalog, catalog);
  h.worker.stop();
});

test('monotonic per-book sequence numbers identify each attempt, including failed attempts', async () => {
  const h = harness(); h.watch('A', 7, ['draftkings']); await flush();
  h.pending[0].reject(new Error('Fail')); await flush();
  await h.advance(15000); h.pending[1].resolve(data(h.pending[1])); await flush();
  assert.deepEqual(h.sent.filter(m => ['failure', 'result'].includes(m.type)).map(m => [m.sequence, m.generation]), [[1, 7], [2, 7]]);
  h.worker.stop();
});

test('removed or replaced generations cannot publish a late response', async () => {
  const h = harness(); h.watch('A', 1, ['draftkings']); await flush();
  const old = h.pending[0]; h.watch('A', 2, ['draftkings']);
  assert.equal(old.options.signal.aborted, true);
  old.resolve(data(old, { rows: [{ old: true }] })); await flush();
  assert.equal(h.sent.length, 0); assert.equal(h.pending.length, 2);
  h.pending[1].resolve(data(h.pending[1])); await flush();
  assert.deepEqual(h.sent.map(m => m.generation), [2]);
  h.worker.command({ type: 'unwatch', gameId: 'A' });
  await h.advance(15000); assert.equal(h.calls.length, 2);
  h.worker.stop();
});

test('429 retry-after is book-wide and blocks another game while the other book continues', async () => {
  const h = harness(); h.watch('A'); h.watch('B'); await flush();
  const dk = h.pending.find(p => p.book === 'draftkings'), fd = h.pending.find(p => p.book === 'fanduel');
  dk.reject(new UpstreamError('Rate limited', 429, 60000)); fd.resolve(data(fd)); await flush();
  assert.equal(h.sent.find(m => m.type === 'cooldown').until, 61000);
  assert.equal(h.calls.filter(c => c.book === 'draftkings').length, 1);
  assert.equal(h.calls.filter(c => c.book === 'fanduel').length, 2);
  await h.advance(59999); assert.equal(h.calls.filter(c => c.book === 'draftkings').length, 1);
  await h.advance(1); assert.equal(h.calls.filter(c => c.book === 'draftkings').length, 2);
  assert.equal(h.calls.filter(c => c.book === 'draftkings').at(-1).game.id, 'B');
  h.worker.stop();
});

test('canceling a game cannot discard an already arriving Retry-After deadline', async () => {
  const h = harness(); h.watch('A', 1, ['draftkings']); h.watch('B', 1, ['draftkings']); await flush();
  const old = h.pending[0]; h.worker.command({ type: 'unwatch', gameId: 'A' });
  old.reject(new UpstreamError('Rate limited', 429, 90000)); await flush();
  assert.equal(h.sent.filter(m => m.type === 'failure').length, 0);
  assert.equal(h.sent.find(m => m.type === 'cooldown').until, 91000);
  assert.equal(h.calls.length, 1);
  await h.advance(90000); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].game.id, 'B');
  h.worker.stop();
});

test('parent cooldown survives worker restart and cannot be shortened by a later watch', async () => {
  const h = harness();
  h.watch('A', 1, ['draftkings'], { cooldowns: { draftkings: 31000 } });
  h.watch('B', 1, ['draftkings'], { cooldowns: { draftkings: 2000 } }); await flush();
  assert.equal(h.calls.length, 0);
  await h.advance(29999); assert.equal(h.calls.length, 0);
  await h.advance(1); assert.equal(h.calls.length, 1);
  h.worker.stop();
});

test('successful snapshots replace rows and next attempt never begins before the polling cadence', async () => {
  const h = harness(); h.watch('A', 1, ['draftkings']); await flush();
  h.pending[0].resolve(data(h.pending[0], { rows: [{ id: 'old' }] })); await flush();
  await h.advance(14999); assert.equal(h.calls.length, 1);
  await h.advance(1); assert.equal(h.calls.length, 2);
  h.pending[1].resolve(data(h.pending[1], { rows: [] })); await flush();
  assert.deepEqual(h.sent.filter(m => m.type === 'result').map(m => m.data.rows), [[{ id: 'old' }], []]);
  h.worker.stop();
});

test('stopping aborts requests, clears timers, ignores further commands, and suppresses late publication', async () => {
  const h = harness(); h.watch('A'); await flush();
  h.worker.stop();
  assert.ok(h.pending.every(p => p.options.signal.aborted));
  for (const job of h.pending) job.resolve(data(job));
  await flush(); h.watch('B'); await h.advance(100000);
  assert.equal(h.calls.length, 2); assert.equal(h.sent.length, 0);
  assert.equal(h.worker.games.size, 0); assert.equal(h.timers.size, 0);
});

test('the default curl worker shares one transport client across polls and closes it exactly once', async () => {
  const previous = process.env.DK_HTTP_TRANSPORT;
  process.env.DK_HTTP_TRANSPORT = 'curl';
  const fixture = JSON.parse(await readFile(new URL('./fixtures/extras-ontario.json', import.meta.url)));
  let now = Date.now(), created = 0, fetched = 0, closed = 0;
  const timers = new Map(), sent = [], client = { fetch: async requests => {
    fetched++; return requests.map(r => ({ id: r.id, data: fixture.draftkings[r.id], receivedAt: now }));
  }, close: () => closed++ };
  const worker = new ExtrasWorker({ send: m => sent.push(m), now: () => now,
    batchClientFactory: () => { created++; return client; },
    schedule: (fn, ms) => { timers.set(fn, now+ms); return fn; }, cancel: fn => timers.delete(fn) });
  try {
    const game = makeGame('draftkings', '34118182', 'CAR', 'GB', '2026-10-30T00:15:00Z');
    worker.command({ type: 'watch', gameId: game.id, generation: 1, sourceGames: { draftkings: game } });
    await flush();
    assert.equal(fetched, 1); assert.equal(sent[0].data.rows.length, 14);
    now += 15000;
    for (const [fn, due] of [...timers]) if (due <= now) { timers.delete(fn); fn(); }
    await flush();
    assert.equal(created, 1); assert.equal(fetched, 2);
    assert.equal(sent.filter(m => m.type === 'result').length, 2);
    worker.stop(); worker.stop(); assert.equal(closed, 1);
  } finally {
    worker.stop(); if (previous === undefined) delete process.env.DK_HTTP_TRANSPORT; else process.env.DK_HTTP_TRANSPORT = previous;
  }
});

test('native and injected-fetch workers never create a Python transport client', () => {
  const previous = process.env.DK_HTTP_TRANSPORT;
  try {
    process.env.DK_HTTP_TRANSPORT = 'native';
    const native = new ExtrasWorker({ send() {}, batchClientFactory: () => { throw new Error('must not create'); } });
    native.stop();
    process.env.DK_HTTP_TRANSPORT = 'curl';
    const injected = new ExtrasWorker({ send() {}, fetchers: { draftkings: async () => ({}) },
      batchClientFactory: () => { throw new Error('must not create'); } });
    injected.stop();
  } finally {
    if (previous === undefined) delete process.env.DK_HTTP_TRANSPORT; else process.env.DK_HTTP_TRANSPORT = previous;
  }
});

test('worker stop aborts a pending default-transport batch and closes its client', async () => {
  const previous = process.env.DK_HTTP_TRANSPORT;
  process.env.DK_HTTP_TRANSPORT = 'curl';
  let signal, closed = 0; const sent = [], deferred = Promise.withResolvers();
  const worker = new ExtrasWorker({ send: m => sent.push(m), batchClientFactory: () => ({
    fetch: (requests, options) => { signal = options.signal; return deferred.promise; }, close: () => closed++,
  }) });
  try {
    const game = makeGame('draftkings', '34118182', 'CAR', 'GB', '2026-10-30T00:15:00Z');
    worker.command({ type: 'watch', gameId: game.id, generation: 1, sourceGames: { draftkings: game } });
    await flush(); worker.stop();
    assert.equal(signal.aborted, true); assert.equal(closed, 1);
    deferred.reject(new DOMException('Canceled', 'AbortError')); await flush();
    assert.equal(sent.length, 0);
  } finally {
    worker.stop(); if (previous === undefined) delete process.env.DK_HTTP_TRANSPORT; else process.env.DK_HTTP_TRANSPORT = previous;
  }
});
