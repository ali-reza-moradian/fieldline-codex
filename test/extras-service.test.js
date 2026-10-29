import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeGame } from '../src/model.js';
import { ExtrasService, extraSourceGames } from '../src/extras-service.js';

class Worker extends EventEmitter {
  connected = true; messages = []; kills = 0; callbacks = [];
  send(message, callback) { this.messages.push(message); this.callbacks.push(callback); }
  kill() { this.kills++; this.connected = false; }
}
class Client {
  destroyed = false; writableEnded = false; writableLength = 0; frames = [];
  write(frame) { this.frames.push(frame); return true; }
  destroy() { this.destroyed = true; }
  end() { this.writableEnded = true; }
}
function setup() {
  const games = [makeGame('draftkings', '1', 'CAR', 'GB', '2026-10-30T00:15:00Z'),
    makeGame('draftkings', '2', 'BAL', 'BUF', '2026-11-01T18:00:00Z'),
    makeGame('draftkings', '3', 'TEN', 'CIN', '2026-11-01T18:00:00Z')];
  const store = { boards: new Map(games.map(g => [g.id, { ...g, books: ['draftkings', 'fanduel'] }])),
    datasets: { draftkings: { games }, fanduel: { games: games.map(g => ({ ...g, book: 'fanduel', sourceId: String(Number(g.sourceId)+10) })) } } };
  const workers = [], service = new ExtrasService({ store, now: () => 10000, workerFactory: () => {
    const worker = new Worker(); workers.push(worker); return worker;
  } });
  return { store, service, games, workers };
}
function quote(game, book, { kind = 'alt-spread', subject = 'away', line = 3.5, observedAt = 9000, american = 100, protection } = {}) {
  const operator = ['pass-yds', 'rush-yds', 'rec-yds', 'receptions'].includes(kind) ? 'gte' : undefined;
  return { id: `${book}:quote`, key: [game.id, 'full_game', kind, subject, line ?? '', operator ?? ''].join('|'),
    kind, subject, name: 'Carolina Panthers', line, american, decimal: american > 0 ? 1+american/100 : 1+100/-american,
    suspended: false, observedAt, period: 'full_game', rules: 'including_overtime', thresholdOperator: operator, protection };
}
function result(service, game, book = 'draftkings', { sequence = 1, observedAt = 9000, rows, complete = true, generation, ...rest } = {}) {
  return { type: 'result', gameId: game.id, generation: generation ?? service.games.get(game.id).generation, sequence, book,
    data: { book, gameId: game.id, region: 'Ontario', observedAt, rows: rows ?? [quote(game, book, { observedAt })],
      coverage: { complete }, durationMs: 10, warnings: [], decodedBytes: 100, ...rest } };
}

test('same-game viewers share one dataset and worker; two-game cap is global', () => {
  const { service, games, workers } = setup();
  const a = service.watch(games[0].id, new Client()), b = service.watch(games[0].id, new Client());
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(workers.length, 1); assert.equal(service.games.size, 1);
  const c = service.watch(games[1].id, new Client());
  assert.equal(c.status, 200);
  assert.equal(service.watch(games[2].id, new Client()).status, 503);
  a.release(); assert.equal(service.games.size, 2);
  b.release(); assert.equal(service.games.size, 1);
  assert.equal(workers[0].messages.filter(m => m.type === 'unwatch').length, 1);
  c.release(); assert.equal(service.games.size, 0); assert.equal(workers[0].kills, 1);
  service.stop();
});

test('source failure is independent and suspended/partial coverage cannot appear healthy', () => {
  const { service, games } = setup(); const game = games[0];
  service.watch(game.id, new Client());
  service.receive(result(service, game));
  service.receive(result(service, game, 'fanduel'));
  service.receive({ type: 'failure', gameId: game.id, generation: service.games.get(game.id).generation,
    sequence: 2, book: 'draftkings', error: 'Upstream unavailable' });
  let snapshot = service.snapshot(service.games.get(game.id));
  assert.equal(snapshot.sources.draftkings.status, 'stale');
  assert.equal(snapshot.sources.fanduel.status, 'healthy');
  service.receive(result(service, game, 'draftkings', { sequence: 3, observedAt: 9100, complete: false, rows: [] }));
  snapshot = service.snapshot(service.games.get(game.id));
  assert.equal(snapshot.sources.draftkings.status, 'stale');
  assert.equal(snapshot.sources.draftkings.lastConfirmedAt, 9000);
  assert.ok(snapshot.rows.every(r => !r.offers.draftkings));
  service.stop();
});

test('full replacement removes old contracts and generation/sequence guards prevent resurrection', () => {
  const { service, games } = setup(); const game = games[0], client = new Client();
  const watch = service.watch(game.id, client), generation = service.games.get(game.id).generation;
  const old = result(service, game);
  service.receive(old);
  service.receive(result(service, game, 'draftkings', { sequence: 2, observedAt: 9100, rows: [] }));
  service.receive(old);
  assert.equal(service.snapshot(service.games.get(game.id)).rows.length, 0);
  const equalTime = result(service, game, 'draftkings', { sequence: 3, observedAt: 9100 });
  service.receive(equalTime);
  assert.equal(service.snapshot(service.games.get(game.id)).rows.length, 0);
  watch.release();
  service.watch(game.id, new Client());
  assert.ok(service.games.get(game.id).generation > generation);
  service.receive(old);
  assert.equal(service.snapshot(service.games.get(game.id)).rows.length, 0);
  service.stop();
});

test('old failures and invalid book/region/game responses cannot overwrite good observations', () => {
  const { service, games } = setup(); const game = games[0];
  service.watch(game.id, new Client());
  service.receive(result(service, game, 'draftkings', { sequence: 2 }));
  service.receive({ type: 'failure', gameId: game.id, generation: service.games.get(game.id).generation,
    sequence: 1, book: 'draftkings', error: 'Late failure' });
  for (const patch of [{ region: 'New Jersey' }, { gameId: games[1].id }, { book: 'fanduel' }]) {
    service.receive(result(service, game, 'draftkings', { sequence: 3, observedAt: 9100, ...patch }));
  }
  const source = service.snapshot(service.games.get(game.id)).sources.draftkings;
  assert.equal(source.status, 'healthy'); assert.equal(source.lastConfirmedAt, 9000);
  service.stop();
});

test('duplicate or mismatched row contracts stale the source instead of merging unsafe prices', () => {
  const { service, games } = setup(); const game = games[0];
  service.watch(game.id, new Client());
  const row = quote(game, 'draftkings');
  service.receive(result(service, game, 'draftkings', { rows: [row, { ...row, id: 'draftkings:other' }] }));
  const snapshot = service.snapshot(service.games.get(game.id));
  assert.equal(snapshot.sources.draftkings.status, 'stale');
  assert.equal(snapshot.rows.length, 0);
  service.stop();
});

test('ambiguous source event mapping is quarantined while the other book remains usable', () => {
  const { store, service, games } = setup(); const game = games[0];
  store.datasets.draftkings.games.push({ ...game, sourceId: '999' });
  const sources = extraSourceGames(store, game.id);
  assert.equal(sources.draftkings, undefined); assert.ok(sources.fanduel);
  const watch = service.watch(game.id, new Client());
  assert.equal(watch.snapshot.sources.draftkings.status, 'unavailable');
  service.receive(result(service, game));
  assert.equal(service.snapshot(service.games.get(game.id)).rows.length, 0);
  service.stop();
});

test('source identity changes abort the old generation and clear its old quotes on heartbeat', () => {
  const { store, service, games, workers } = setup(); const game = games[0];
  service.watch(game.id, new Client());
  const previous = result(service, game); service.receive(previous);
  store.datasets.draftkings.games[0] = { ...game, sourceId: '999' };
  service.heartbeat();
  assert.ok(service.games.get(game.id).generation > previous.generation);
  assert.equal(service.snapshot(service.games.get(game.id)).rows.length, 0);
  assert.equal(workers[0].messages.at(-1).sourceGames.draftkings.sourceId, '999');
  service.receive(previous);
  assert.equal(service.snapshot(service.games.get(game.id)).rows.length, 0);
  service.stop();
});

test('prop offers are never marked comparable; alternate contracts need both books and equal protection', () => {
  const { service, games } = setup(); const game = games[0];
  service.watch(game.id, new Client());
  const rows = book => [quote(game, book), quote(game, book, { kind: 'td', subject: 'joshjacobs', line: null }),
    quote(game, book, { kind: 'receptions', subject: 'christianwatson', line: 3 }),
    quote(game, book, { kind: 'alt-total', subject: 'over', line: 45.5, protection: book === 'draftkings' ? 'early_exit' : undefined })];
  service.receive(result(service, game, 'draftkings', { rows: rows('draftkings') }));
  assert.ok(service.snapshot(service.games.get(game.id)).rows.every(r => r.comparable === false));
  service.receive(result(service, game, 'fanduel', { rows: rows('fanduel') }));
  const snapshot = service.snapshot(service.games.get(game.id));
  assert.equal(snapshot.rows.find(r => r.kind === 'alt-spread').comparable, true);
  assert.ok(snapshot.rows.filter(r => r.kind !== 'alt-spread').every(r => r.comparable === false));
  service.stop();
});

test('worker restart preserves stale displays until a new-generation result arrives', () => {
  const { service, games, workers } = setup(); const game = games[0], client = new Client();
  service.watch(game.id, client);
  const oldResult = result(service, game); workers[0].emit('message', oldResult);
  workers[0].emit('exit', 1);
  assert.equal(service.snapshot(service.games.get(game.id)).sources.draftkings.status, 'stale');
  service.startWorker(); service.sendWatches();
  assert.equal(workers.length, 2);
  workers[0].emit('message', oldResult);
  assert.equal(service.snapshot(service.games.get(game.id)).sources.draftkings.status, 'stale');
  workers[1].emit('message', result(service, game, 'draftkings', { observedAt: 9100 }));
  assert.equal(service.snapshot(service.games.get(game.id)).sources.draftkings.status, 'healthy');
  service.stop();
});

test('a delayed old-worker send callback cannot kill its replacement', () => {
  const { service, games, workers } = setup();
  service.watch(games[0].id, new Client());
  const oldCallback = workers[0].callbacks[0];
  workers[0].emit('exit', 1); service.startWorker(); service.sendWatches();
  oldCallback(new Error('Old IPC closed'));
  assert.equal(workers[1].kills, 0);
  service.stop();
});

test('rate-limit deadlines survive idle worker shutdown and are passed to the replacement', () => {
  const { service, games, workers } = setup();
  const watch = service.watch(games[0].id, new Client());
  workers[0].emit('message', { type: 'cooldown', book: 'draftkings', until: 70000 });
  watch.release(); service.watch(games[1].id, new Client());
  assert.equal(workers[1].messages[0].cooldowns.draftkings, 70000);
  service.stop();
});

test('slow or closed SSE clients are dropped without blocking healthy viewers', () => {
  const { service, games } = setup(), slow = new Client(), healthy = new Client();
  service.watch(games[0].id, slow); service.watch(games[0].id, healthy);
  slow.writableLength = 1024*1024;
  service.receive(result(service, games[0]));
  assert.equal(slow.destroyed, true); assert.equal(healthy.destroyed, false);
  assert.equal(healthy.frames.length, 1);
  assert.match(healthy.frames[0], /^id: 1\nevent: snapshot\ndata: /);
  service.stop(); assert.equal(healthy.writableEnded, true);
  assert.equal(service.watch(games[0].id, new Client()).status, 503);
});
