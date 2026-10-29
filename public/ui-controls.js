import { sourceFresh } from './presentation.js';

const choices = { layout: ['board', 'grid'], density: ['comfortable', 'compact'], scheme: ['light', 'dark'], sort: ['kickoff', 'hold', 'ev'] };
export const safePreference = (key, value) => choices[key]?.includes(value) ? value : choices[key]?.[0];
export function parseFavorites(value) {
  try { const list = JSON.parse(value); return new Set(Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.length <= 160).slice(0, 100) : []); }
  catch { return new Set(); }
}
export function shortcutAction(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return event.key === 'Escape' ? 'escape' : null;
  return ({ '/': 'search', '1': 'best', '2': 'draftkings', '3': 'fanduel', c: 'density', d: 'scheme', s: 'star', '?': 'help', Escape: 'escape' })[event.key.length === 1 && /[a-z]/i.test(event.key) ? event.key.toLowerCase() : event.key] ?? null;
}
export function sortGames(games, { favorites = new Set(), sort = 'kickoff', analytics = new Map() } = {}) {
  return [...games].sort((a, b) => {
    const pinned = Number(favorites.has(b.id)) - Number(favorites.has(a.id));
    if (pinned) return pinned;
    if (sort !== 'kickoff') {
      const key = sort === 'hold' ? 'bestHoldPercent' : 'bestEstimatedEvPercent';
      const aa = analytics.get(a.id)?.[key], bb = analytics.get(b.id)?.[key];
      const av = Number.isFinite(aa), bv = Number.isFinite(bb);
      if (av !== bv) return Number(bv) - Number(av);
      if (av && aa !== bb) return sort === 'hold' ? aa - bb : bb - aa;
    }
    return Number(b.live) - Number(a.live) || Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id);
  });
}
export const validExtraKinds = ['alt-spread', 'alt-total', 'td', 'pass-yds', 'rush-yds', 'rec-yds', 'receptions'];
export function extraLineLabel(row) {
  if (row.line == null) return '';
  if (!Number.isFinite(row.line)) return 'Unverified line';
  if (row.kind === 'alt-spread') return row.line > 0 ? `+${row.line}` : row.line < 0 ? `−${Math.abs(row.line)}` : 'PK';
  return `${row.line}${row.thresholdOperator === 'gte' ? '+' : ''}`;
}
export function extraOffers(row, sources, { now, connected, clockUncertaintyMs = 0 }) {
  const eligible = {};
  for (const book of ['draftkings', 'fanduel']) {
    const q = row.offers?.[book], source = sources[book];
    const fresh = sourceFresh(source, { connected, now, clockUncertaintyMs });
    const validOdds = Number.isFinite(q?.american) && Math.abs(q.american) >= 100;
    const age = now - q?.observedAt;
    const current = Number.isFinite(age) && age >= -Math.max(1000, clockUncertaintyMs) && age < source?.staleAfterMs;
    const decimal = validOdds ? q.american > 0 ? 1 + q.american / 100 : 1 + 100 / -q.american : null;
    const validDecimal = q?.decimal == null || (Number.isFinite(q.decimal) && Math.abs(q.decimal - decimal) < 1e-8);
    eligible[book] = { ...q, book, decimal, stale: !fresh || !current, available: !!q && fresh && current && !q.suspended && !q.missing && validOdds && validDecimal };
  }
  const available = Object.values(eligible).filter(q => q.available);
  const both = available.length === 2 && row.comparable === true && ['alt-spread', 'alt-total'].includes(row.kind);
  const best = both ? Math.max(...available.map(q => q.decimal)) : null;
  return { offers: eligible, bestBooks: best === null ? [] : available.filter(q => Math.abs(q.decimal - best) < 1e-9).map(q => q.book) };
}

/** Only one chart is requested at a time. History work never delays live prices. */
export class HistoryLoader {
  constructor({ fetchFn = (...args) => fetch(...args), onChange = () => {}, now = () => Date.now(), setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = id => clearTimeout(id) } = {}) {
    Object.assign(this, { fetchFn, onChange, now, setTimeoutFn, clearTimeoutFn });
    this.selection = null; this.generation = 0; this.version = 0; this.data = null; this.error = null; this.loading = false; this.controller = null; this.timer = null; this.lastRequestedAt = 0; this.pendingRefresh = false;
  }
  select(selection) {
    this.close();
    if (!selection) return;
    this.selection = { ...selection }; this.load();
  }
  close() {
    this.generation++; this.controller?.abort(); this.controller = null;
    this.clearTimeoutFn(this.timer); this.timer = null; this.selection = null;
    this.data = null; this.error = null; this.loading = false; this.pendingRefresh = false; this.version++;
  }
  refresh() {
    if (!this.selection) return;
    if (this.loading) { this.pendingRefresh = true; return; }
    if (this.timer !== null) return;
    const delay = Math.max(0, 1000 - (this.now() - this.lastRequestedAt));
    this.timer = this.setTimeoutFn(() => { this.timer = null; this.load(); }, delay);
  }
  async load() {
    if (!this.selection || this.loading) return;
    const selection = this.selection, generation = this.generation;
    this.controller = new AbortController(); const controller = this.controller;
    let timer;
    const deadline = new Promise((_, reject) => { timer = this.setTimeoutFn(() => { controller.abort(); reject(new Error("Saved history took too long to respond.")); }, 6000); });
    this.loading = true; this.lastRequestedAt = this.now();
    try {
      const query = new URLSearchParams({ ...selection, hours: '48' });
      const body = await Promise.race([deadline, (async () => {
        const response = await this.fetchFn('/api/history?' + query, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Saved history is temporarily unavailable.');
        return response.json();
      })()]);
      if (!body || !Number.isFinite(body.generatedAt) || !Array.isArray(body.series)) throw new Error('Saved history could not be read.');
      const seen = new Set();
      for (const s of body.series) {
        if (!['draftkings', 'fanduel'].includes(s.book) || seen.has(s.book) || s.gameId !== selection.gameId || s.market !== selection.market || s.side !== selection.side || !Array.isArray(s.points) || s.points.length > 6000) throw new Error('Saved history did not match this selection.');
        seen.add(s.book); let previous = -Infinity;
        for (const p of s.points) {
          if (!p || !Number.isFinite(p.at) || p.at < previous || p.at > body.generatedAt + 1000) throw new Error('Saved history timestamps were invalid.');
          if (p.line != null && !Number.isFinite(p.line)) throw new Error('Saved history contained an invalid line.');
          if (!p.gap && !p.missing && !p.suspended && (!Number.isFinite(p.american) || Math.abs(p.american) < 100)) throw new Error('Saved history contained an invalid price.');
          previous = p.at;
        }
      }
      if (generation !== this.generation) return;
      this.data = body; this.error = null; this.version++;
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = controller.signal.aborted ? 'Saved history took too long to respond.' : error.message;
      this.version++;
    } finally {
      this.clearTimeoutFn(timer);
      if (generation === this.generation) { this.controller = null; this.loading = false; this.onChange(); if (this.pendingRefresh) { this.pendingRefresh = false; this.refresh(); } }
    }
  }
}

export function historyStorageLabel(storage) {
  if (!storage?.enabled) return "History is held in memory and may reset when the server restarts.";
  if (storage.state === 'unavailable') return "Cloud history storage is unavailable. New observations remain in memory until storage recovers.";
  if (!Number.isFinite(storage.lastSavedAt)) return "Cloud storage is connecting or preparing its first checkpoint. New observations are currently held in memory.";
  if (!storage.available) return "Cloud storage is reconnecting. New observations remain in memory while it reconnects.";
  return "Cloud checkpoints preserve history across restarts; observations since the last checkpoint may be lost on a restart.";
}
