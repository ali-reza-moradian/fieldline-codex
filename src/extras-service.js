import { fork } from 'node:child_process';
import { EXTRA_KINDS } from './extras/normalize.js';

const BOOKS = ['draftkings', 'fanduel'];
const FRAME_LIMIT = 1024*1024;
const initialSource = book => ({ book, region: 'Ontario', status: 'connecting', lastConfirmedAt: null,
  staleAfterMs: 45000, pollMs: 15000, error: null });
export function extraSourceGames(store, id) {
  const merged = store.boards.get(id); if (!merged) return null;
  const sources = {};
  for (const book of merged.books) {
    const matches = (store.datasets[book]?.games ?? []).filter(game => game.away.id === merged.away.id &&
      game.home.id === merged.home.id && Math.abs(Date.parse(game.startsAt)-Date.parse(merged.startsAt)) <= 30*60000);
    if (matches.length === 1) sources[book] = { ...matches[0], id };
  }
  return Object.keys(sources).length ? sources : null;
}

export class ExtrasService {
  constructor({ store, now = Date.now, workerFactory = () => fork(new URL('./extras-worker.js', import.meta.url), [],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }), maxGames = 2 } = {}) {
    Object.assign(this, { store, now, workerFactory, maxGames });
    this.games = new Map(); this.worker = null; this.generation = 0; this.cooldowns = {};
    this.restartTimer = null; this.stopped = false;
    this.counters = { snapshots: 0, failures: 0, workerRestarts: 0, upstreamBytes: 0 };
  }
  startWorker() {
    if (this.worker || this.stopped) return;
    clearTimeout(this.restartTimer); this.restartTimer = null;
    const worker = this.workerFactory(); this.worker = worker;
    worker.on('message', message => { if (this.worker === worker) this.receive(message); });
    const lost = () => {
      if (this.worker !== worker) return;
      this.worker = null; this.counters.workerRestarts++;
      for (const game of this.games.values()) {
        game.generation = ++this.generation; game.sequences = {};
        for (const book of Object.keys(game.sourceGames)) Object.assign(game.sources[book], { status: 'stale', error: 'Extra-market worker disconnected; reconnecting' });
        this.publish(game);
      }
      worker.kill();
      if (this.games.size && !this.stopped) {
        this.restartTimer = setTimeout(() => { this.startWorker(); this.sendWatches(); }, 5000);
        this.restartTimer.unref?.();
      }
    };
    worker.on('exit', lost); worker.on('error', lost);
  }
  sendWatches() {
    for (const active of this.games.values()) this.send({ type: 'watch', gameId: active.id,
      generation: active.generation, sourceGames: active.sourceGames, cooldowns: this.cooldowns });
  }
  send(message) {
    const worker = this.worker;
    if (!worker || worker.connected === false) return;
    try { worker.send(message, error => { if (error) worker.kill(); }); } catch { worker.kill(); }
  }
  refreshSources(game, sourceGames = extraSourceGames(this.store, game.id) ?? {}) {
    const identity = sources => JSON.stringify(BOOKS.map(book => {
      const g = sources[book]; return g ? [g.sourceId, g.away.id, g.home.id, g.startsAt] : null;
    }));
    if (identity(game.sourceGames) === identity(sourceGames)) return;
    game.sourceGames = sourceGames; game.generation = ++this.generation; game.sequences = {}; game.datasets = {};
    game.sources = Object.fromEntries(BOOKS.map(book => [book, { ...initialSource(book),
      ...(sourceGames[book] ? {} : { status: 'unavailable', error: 'This book has no safely matched event' }) }]));
    this.send({ type: 'watch', gameId: game.id, generation: game.generation, sourceGames, cooldowns: this.cooldowns });
    this.publish(game);
  }
  watch(gameId, client) {
    if (this.stopped) return { status: 503, error: 'Extra markets are shutting down' };
    if (!this.games.has(gameId) && this.games.size >= this.maxGames)
      return { status: 503, error: 'Extra markets are busy for two games. Close another game or retry shortly.' };
    const sourceGames = extraSourceGames(this.store, gameId);
    if (!sourceGames) return { status: 404, error: 'Game unavailable or its identity could not be matched safely' };
    let game = this.games.get(gameId);
    if (!game) {
      game = { id: gameId, sourceGames, generation: ++this.generation, revision: 0, clients: new Set(),
        datasets: {}, sequences: {}, sources: Object.fromEntries(BOOKS.map(book => [book, { ...initialSource(book),
          ...(sourceGames[book] ? {} : { status: 'unavailable', error: 'This book has no safely matched event' }) }])) };
      this.games.set(gameId, game);
    } else this.refreshSources(game, sourceGames);
    this.startWorker();
    // A restarted worker needs the existing watches as well as the newest one.
    this.sendWatches();
    game.clients.add(client);
    return { status: 200, snapshot: this.snapshot(game), release: () => {
      game.clients.delete(client);
      if (!game.clients.size && this.games.get(gameId) === game) {
        this.games.delete(gameId); this.send({ type: 'unwatch', gameId });
        if (!this.games.size) { const worker = this.worker; this.worker = null; worker?.kill(); }
      }
    }};
  }
  receive(message) {
    if (message.type === 'cooldown' && BOOKS.includes(message.book) && Number.isFinite(message.until)) {
      this.cooldowns[message.book] = Math.max(this.cooldowns[message.book] ?? 0, message.until); return;
    }
    const game = this.games.get(message.gameId);
    if (!game || game.generation !== message.generation || !BOOKS.includes(message.book) ||
        !game.sourceGames[message.book] || !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
        message.sequence <= (game.sequences[message.book] ?? 0)) return;
    const source = game.sources[message.book];
    if (message.type === 'failure') {
      game.sequences[message.book] = message.sequence;
      Object.assign(source, { status: 'stale', error: message.error, lastErrorAt: this.now() }); this.counters.failures++;
    } else if (message.type === 'result') {
      const data = message.data;
      if (!Array.isArray(data?.rows) || data.rows.length > 5000 || !Number.isFinite(data.observedAt) ||
        data.observedAt <= 0 || data.observedAt > this.now()+1000 || data.observedAt <= (source.lastConfirmedAt ?? 0) ||
        data.gameId !== game.id || data.book !== message.book || data.region !== 'Ontario') return;
      const keys = new Set();
      const invalid = data.rows.some(quote => {
        if (!quote || typeof quote !== 'object') return true;
        const key = [game.id, 'full_game', quote.kind, quote.subject, quote.line ?? '', quote.thresholdOperator ?? ''].join('|');
        if (!EXTRA_KINDS.includes(quote.kind) || quote.period !== 'full_game' || quote.rules !== 'including_overtime' ||
            quote.key !== key || keys.has(key) || typeof quote.id !== 'string' || !quote.id.startsWith(`${message.book}:`) ||
            typeof quote.name !== 'string' || typeof quote.subject !== 'string' || !Number.isFinite(quote.observedAt) ||
            quote.observedAt < data.observedAt || quote.observedAt > this.now()+1000 || typeof quote.suspended !== 'boolean' ||
            (quote.suspended ? quote.american !== null || quote.decimal !== null :
              !Number.isFinite(quote.american) || Math.abs(quote.american) < 100 || !Number.isFinite(quote.decimal) || quote.decimal <= 1)) return true;
        keys.add(key); return false;
      });
      game.sequences[message.book] = message.sequence;
      if (invalid) {
        Object.assign(source, { status: 'stale', error: 'Extra-market response failed contract validation', lastErrorAt: this.now() });
        this.counters.failures++; this.publish(game); return;
      }
      game.datasets[message.book] = data;
      const complete = data.coverage?.complete === true;
      Object.assign(source, { status: complete ? 'healthy' : 'stale', error: complete ? null : 'Extra-market coverage is incomplete',
        ...(complete ? { lastConfirmedAt: data.observedAt } : {}),
        coverage: data.coverage, warnings: data.warnings, requestMs: data.durationMs });
      this.counters.upstreamBytes += data.decodedBytes ?? 0;
    } else return;
    this.publish(game);
  }
  snapshot(game) {
    const rows = new Map();
    for (const book of BOOKS) for (const quote of game.datasets[book]?.rows ?? []) {
      const row = rows.get(quote.key) ?? { id: quote.key, kind: quote.kind, subject: quote.subject,
        name: quote.name, line: quote.line, period: quote.period, rules: quote.rules,
        thresholdOperator: quote.thresholdOperator, offers: {} };
      row.offers[book] = { american: quote.american, decimal: quote.decimal, suspended: quote.suspended,
        observedAt: quote.observedAt, protection: quote.protection };
      rows.set(quote.key, row);
    }
    // House rules for props can differ even when the named outcome matches.
    // Show the two offers, but reserve best-price ranking for alternate lines.
    for (const row of rows.values()) row.comparable = row.kind.startsWith('alt-') &&
      Boolean(row.offers.draftkings && row.offers.fanduel) &&
      JSON.stringify(row.offers.draftkings?.protection ?? null) === JSON.stringify(row.offers.fanduel?.protection ?? null);
    return { gameId: game.id, games: [], revision: game.revision, sentAt: this.now(),
      rows: [...rows.values()], sources: game.sources,
      rulesNote: Object.values(game.datasets).find(d => d.rulesNote)?.rulesNote ?? null };
  }
  publish(game) {
    game.revision++; this.counters.snapshots++;
    const frame = `id: ${game.revision}\nevent: snapshot\ndata: ${JSON.stringify(this.snapshot(game))}\n\n`;
    for (const client of game.clients) this.write(client, frame);
  }
  write(client, frame) {
    if (client.destroyed || client.writableEnded || client.writableLength+Buffer.byteLength(frame) > FRAME_LIMIT) {
      client.destroy(); return;
    }
    try { client.write(frame); } catch { client.destroy(); }
  }
  heartbeat() {
    const frame = `event: heartbeat\ndata: ${JSON.stringify({ sentAt: this.now() })}\n\n`;
    for (const game of this.games.values()) {
      this.refreshSources(game);
      for (const client of game.clients) this.write(client, frame);
    }
  }
  report() { return { ...this.counters, activeGames: this.games.size, viewers: [...this.games.values()].reduce((n,g)=>n+g.clients.size,0),
    pollMs: 15000, staleAfterMs: 45000, region: 'Ontario', isolatedProcess: true }; }
  stop() {
    this.stopped = true; clearTimeout(this.restartTimer);
    for (const game of this.games.values()) for (const client of game.clients) client.end();
    this.games.clear(); const worker = this.worker; this.worker = null; worker?.kill();
  }
}
