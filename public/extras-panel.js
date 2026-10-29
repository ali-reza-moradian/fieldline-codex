import { BoardStream, mergeFreshness } from './stream.js';
import { sourceFresh } from './presentation.js';

/** An optional stream for exactly one game; it never mutates the main board. */
export class ExtrasPanel {
  constructor({ getClock = () => null, now = () => Date.now(), onChange = () => {}, streamFactory = options => new BoardStream(options) } = {}) {
    Object.assign(this, { getClock, now, onChange, streamFactory });
    this.gameId = null; this.sources = {}; this.rows = []; this.connected = false; this.revision = -1; this.version = 0; this.stream = null;
    this.kind = 'all'; this.query = ''; this.page = 0; this.healthKey = ''; this.message = null;
  }
  fresh(book) { return sourceFresh(this.sources[book], { connected: this.connected, now: this.getClock()?.now ?? this.now(), clockUncertaintyMs: this.getClock()?.uncertaintyMs ?? 0 }); }
  open(gameId) {
    this.close(); this.gameId = gameId; this.kind = 'all'; this.query = ''; this.page = 0;
    const generation = this.version;
    this.stream = this.streamFactory({ url: '/api/extras/events?' + new URLSearchParams({ gameId }), getClock: this.getClock,
      onEvent: (type, data) => {
        if (generation !== this.openGeneration) return;
        if (type === 'snapshot') {
          if (data.gameId !== this.gameId || !Array.isArray(data.rows)) throw new Error('Extra markets did not match this game');
          this.sources = data.sources; this.rows = data.rows.filter(row => row && typeof row.id === 'string' && ['alt-spread', 'alt-total', 'td', 'pass-yds', 'rush-yds', 'rec-yds', 'receptions'].includes(row.kind) && row.offers && typeof row.offers === 'object'); this.connected = true; this.revision = data.revision;
          this.message = data.message ?? null; this.rulesNote = typeof data.rulesNote === 'string' ? data.rulesNote : null; this.version++; this.onChange(true);
        } else if (type === 'status') {
          this.sources[data.source.book] = data.source; this.revision = data.revision; this.version++; this.onChange(true);
        } else if (type === 'freshness') {
          const merged = mergeFreshness(this.sources, data, this.revision);
          if (merged) { this.sources = merged.sources; this.revision = merged.revision; this.tick(); this.onChange(false); }
        }
      },
      onDisconnect: () => { if (generation !== this.openGeneration) return; this.connected = false; this.version++; this.onChange(true); },
    });
    this.openGeneration = generation; this.stream.start(); this.onChange(true);
  }
  close() {
    this.stream?.stop(); this.stream = null; this.openGeneration = -1;
    this.gameId = null; this.sources = {}; this.rows = []; this.connected = false; this.message = null; this.rulesNote = null; this.revision = -1; this.version++;
  }
  tick() {
    const key = JSON.stringify([this.fresh('draftkings'), this.fresh('fanduel')]);
    if (key !== this.healthKey) { this.healthKey = key; this.version++; this.onChange(true); }
  }
  resume() { this.stream?.resume(); this.tick(); }
  setFilter({ kind = this.kind, query = this.query, page = 0 } = {}) {
    this.kind = kind; this.query = query; this.page = page; this.version++; this.onChange(true);
  }
  visibleRows() {
    const q = this.query.trim().toLowerCase();
    const rows = this.rows.filter(r => (this.kind === 'all' || r.kind === this.kind) && (!q || String(r.name ?? r.subject ?? '').toLowerCase().includes(q)));
    const pageCount = Math.max(1, Math.ceil(rows.length / 40)); this.page = Math.min(this.page, pageCount - 1);
    return { total: rows.length, pageCount, rows: rows.slice(this.page * 40, (this.page + 1) * 40) };
  }
}
