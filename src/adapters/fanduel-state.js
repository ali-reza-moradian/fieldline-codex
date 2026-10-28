// HTTP has no source version; push updatedAt has only whole-second precision.
// Preserve any push received during a poll. A later-started poll may advance
// state immediately: a healthy push feed can still lag HTTP. Neither feed
// provides a shared version cursor, so cross-channel order is not guaranteed.
export class FanDuelState {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sequence = 0;
    this.prices = new Map();
    this.pushes = new Map();
    this.counters = { accepted: 0, duplicates: 0, outOfOrder: 0, unknown: 0, pollOverwritesPrevented: 0 };
  }
  beginPoll() { return { sequence: this.sequence, startedAt: this.now() }; }
  values() { return [...this.prices.values()]; }
  prune(catalog) {
    for (const map of [this.prices, this.pushes])
      for (const id of map.keys()) if (!catalog.markets[id]) map.delete(id);
  }
  applyPush(markets, timing, catalog) {
    let accepted = 0, rejected = 0, unknown = 0;
    for (const incoming of markets) {
      const id = incoming.marketId, definition = catalog?.markets[id];
      if (!definition) { unknown++; this.counters.unknown++; continue; }
      if (incoming.runnerDetails?.some(r => !definition.runners.some(d => String(d.selectionId) === String(r.selectionId)))) {
        unknown++; this.counters.unknown++; continue;
      }
      const at = Date.parse(incoming.updatedAt), previous = this.pushes.get(id);
      if (Number.isFinite(at) && Number.isFinite(previous?.sourceAt) && at < previous.sourceAt) {
        rejected++; this.counters.outOfOrder++; continue;
      }
      const base = this.prices.get(id) ?? previous?.market ?? {};
      const oldRunners = new Map((base.runnerDetails ?? []).map(r => [String(r.selectionId), r]));
      // PIR supplies the market's runner list, not a list of runner patches.
      // Never retain a removed runner as an active bet. CLOSED without a list
      // can retain old prices only as suspended display values.
      const runners = incoming.runnerDetails
        ? incoming.runnerDetails.map(r => ({ ...oldRunners.get(String(r.selectionId)), ...r }))
        : [...oldRunners.values()];
      const market = { ...base, ...incoming, runnerDetails: runners };
      const signature = JSON.stringify(market);
      if (previous?.signature === signature) { this.counters.duplicates++; continue; }
      // Equal coarse timestamps can contain distinct updates: receive order wins.
      const record = { market, signature, sequence: ++this.sequence,
        receivedAt: timing.receivedAt ?? this.now(), sourceAt: Number.isFinite(at) ? at : previous?.sourceAt };
      this.pushes.set(id, record);
      this.prices.set(id, market);
      this.counters.accepted++; accepted++;
    }
    return { accepted, rejected, unknown };
  }
  applyPoll(prices, token, { catalog } = {}) {
    const next = new Map(prices.filter(p => catalog.markets[p.marketId]).map(p => [p.marketId, p]));
    for (const [id, push] of this.pushes) {
      if (!catalog.markets[id]) continue;
      if (push.sequence > token.sequence) {
        if (JSON.stringify(next.get(id)) !== push.signature) this.counters.pollOverwritesPrevented++;
        next.set(id, push.market);
      }
    }
    this.prices = next;
    this.prune(catalog);
    return this.values();
  }
}
