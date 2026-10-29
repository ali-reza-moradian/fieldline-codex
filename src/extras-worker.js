import { fileURLToPath } from 'node:url';
import { fetchDraftKingsExtras, fetchFanDuelExtras, draftKingsExtrasUsesCurl } from './extras/sources.js';
import { CurlJsonBatchClient } from './curl-batch-http.js';

// Optional markets run in a separate process. There is one request sequence per
// book, shared by every viewer; opening more browsers cannot multiply polling.
export class ExtrasWorker {
  constructor({ send, fetchers, batchClientFactory = () => new CurlJsonBatchClient(),
    now = Date.now, schedule = setTimeout, cancel = clearTimeout, pollMs = 15000 } = {}) {
    if (!fetchers) {
      this.batchClient = draftKingsExtrasUsesCurl() ? batchClientFactory() : null;
      fetchers = {
        draftkings: (game, options) => fetchDraftKingsExtras(game, { ...options, batchClient: this.batchClient }),
        fanduel: fetchFanDuelExtras,
      };
    }
    Object.assign(this, { send, fetchers, now, schedule, cancel, pollMs });
    this.games = new Map(); this.running = new Map(); this.timers = new Map(); this.cooldowns = new Map(); this.stopped = false;
  }
  command(message) {
    if (this.stopped) return;
    for (const [book, until] of Object.entries(message.cooldowns ?? {})) {
      if (this.fetchers[book] && Number.isFinite(until))
        this.cooldowns.set(book, Math.max(until, this.cooldowns.get(book) ?? 0));
    }
    if (message.type === 'watch') {
      const previous = this.games.get(message.gameId);
      if (previous?.generation === message.generation) return;
      if (this.games.size >= 2 && !previous) return;
      this.remove(message.gameId);
      this.games.set(message.gameId, { ...message, books: Object.fromEntries(Object.keys(this.fetchers).map(book =>
        [book, { due: this.now(), failures: 0, catalog: null, sequence: 0 }])) });
    } else if (message.type === 'unwatch') this.remove(message.gameId);
    for (const book of Object.keys(this.fetchers)) this.pump(book);
  }
  remove(id) {
    this.games.delete(id);
    for (const job of this.running.values()) if (job.gameId === id) job.controller.abort();
  }
  pump(book) {
    if (this.stopped || this.running.has(book)) return;
    this.cancel(this.timers.get(book)); this.timers.delete(book);
    const candidates = [...this.games.values()].filter(g => g.sourceGames?.[book]).sort((a,b) => a.books[book].due-b.books[book].due);
    const game = candidates[0]; if (!game) return;
    const state = game.books[book], delay = Math.max(state.due, this.cooldowns.get(book) ?? 0)-this.now();
    if (delay > 0) {
      const timer = this.schedule(() => this.pump(book), delay); timer.unref?.(); this.timers.set(book, timer); return;
    }
    const controller = new AbortController(), started = this.now(), sequence = ++state.sequence;
    this.running.set(book, { gameId: game.gameId, controller });
    Promise.resolve().then(() => this.fetchers[book](game.sourceGames[book], { signal: controller.signal, catalog: state.catalog }))
      .then(result => {
        if (controller.signal.aborted || this.games.get(game.gameId) !== game) return;
        const { catalog, ...data } = result; state.catalog = catalog; state.failures = 0;
        this.send({ type: 'result', gameId: game.gameId, generation: game.generation, sequence, book, data });
      }).catch(error => {
        // A canceled game cannot erase a rate-limit response that has already
        // arrived. Share the server's deadline with every game and the parent,
        // which retains it if an idle worker is stopped or restarted.
        const retryAfterMs = Math.max(0, Number(error.retryAfterMs) || 0);
        if (error.status === 429 || retryAfterMs) {
          const until = Math.max(this.cooldowns.get(book) ?? 0,
            this.now()+Math.max(retryAfterMs, Math.min(120000, this.pollMs*2**Math.min(state.failures,3))));
          this.cooldowns.set(book, until);
          this.send({ type: 'cooldown', book, until });
        }
        if (controller.signal.aborted || this.games.get(game.gameId) !== game) return;
        state.failures++;
        state.due = this.now()+Math.max(retryAfterMs, Math.min(120000, this.pollMs*2**Math.min(state.failures-1,3)));
        this.send({ type: 'failure', gameId: game.gameId, generation: game.generation, sequence, book,
          error: String(error.message).slice(0,240), retryAfterMs });
      }).finally(() => {
        state.due = Math.max(state.due, started+this.pollMs, this.now()+100);
        this.running.delete(book); this.pump(book);
      });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.games.clear();
    for (const job of this.running.values()) job.controller.abort();
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.batchClient?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = new ExtrasWorker({ send: message => { if (process.connected) process.send(message); } });
  process.on('message', message => worker.command(message));
  process.on('disconnect', () => { worker.stop(); process.exit(0); });
  process.once('SIGTERM', () => { worker.stop(); process.exit(0); });
  process.once('SIGINT', () => { worker.stop(); process.exit(0); });
  process.once('exit', () => worker.stop());
}
