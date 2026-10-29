const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = value => Number.isFinite(value) && value > 0;
const revisionNumber = value => Number.isSafeInteger(value) && value >= 0;
const events = ["snapshot", "delta", "status", "freshness", "heartbeat"];

/** A freshness message can advance confirmation times, never source eligibility
 * or other critical state. A late message cannot roll any timestamp backward. */
export function mergeFreshness(sources, data, currentRevision) {
  if (!object(data) || !revisionNumber(data.revision) || data.revision < currentRevision || !object(data.sources)) return null;
  const next = { ...sources }, updatedBooks = [];
  for (const [book, patch] of Object.entries(data.sources)) {
    if (!Object.hasOwn(sources, book) || !object(patch)) continue;
    let changed = false; const source = { ...sources[book] };
    for (const key of ["lastConfirmedAt", "lastDataAt", "lastChangeAt"]) {
      if (timestamp(patch[key]) && (!timestamp(source[key]) || patch[key] > source[key])) {
        source[key] = patch[key]; changed = true;
      }
    }
    if (changed) { next[book] = source; updatedBooks.push(book); }
  }
  return { sources: next, revision: data.revision, updatedBooks };
}

/** Own reconnection rather than leaving a silently open EventSource indefinitely.
 * All deadlines use a monotonic clock; wall time is used only after calibration. */
export class BoardStream {
  constructor({ url = "/api/events", createEventSource = address => new EventSource(address),
    now = () => performance.now(), setTimeoutFn = (callback, delay) => setTimeout(callback, delay), clearTimeoutFn = id => clearTimeout(id),
    getClock = () => null, onEvent = () => {}, onDisconnect = () => {},
    silenceMs = 12000, snapshotMs = 12000, watchMs = 1000, maxLagMs = 12000,
    retryMinMs = 1000, retryMaxMs = 15000 } = {}) {
    Object.assign(this, { url, createEventSource, now, setTimeoutFn, clearTimeoutFn, getClock,
      onEvent, onDisconnect, silenceMs, snapshotMs, watchMs, maxLagMs, retryMinMs, retryMaxMs });
    this.running = false; this.ready = false; this.generation = 0; this.revision = -1;
    this.stream = null; this.watchTimer = null; this.retryTimer = null; this.retryMs = retryMinMs;
  }
  start() {
    if (this.running) return;
    this.running = true; this.retryMs = this.retryMinMs; this.connect();
  }
  stop() {
    this.running = false; this.ready = false; this.generation++;
    this.clearTimeoutFn(this.watchTimer); this.clearTimeoutFn(this.retryTimer);
    this.watchTimer = this.retryTimer = null;
    this.stream?.close(); this.stream = null;
  }
  connect() {
    if (!this.running || this.stream) return;
    this.retryTimer = null; this.ready = false; this.revision = -1;
    this.openedAt = this.lastMessageAt = this.now();
    const generation = ++this.generation;
    let stream;
    try { stream = this.createEventSource(this.url); this.stream = stream; }
    catch { this.fail("Unable to open the update stream"); return; }
    for (const type of events) stream.addEventListener(type, event => {
      if (!this.running || generation !== this.generation || stream !== this.stream) return;
      this.receive(type, event.data);
    });
    stream.onerror = () => {
      if (this.running && generation === this.generation && stream === this.stream) this.fail("Update stream disconnected");
    };
    this.scheduleWatch();
  }
  scheduleWatch() {
    this.clearTimeoutFn(this.watchTimer);
    if (this.running && this.stream) this.watchTimer = this.setTimeoutFn(() => {
      this.watchTimer = null;
      if (this.check()) this.scheduleWatch();
    }, this.watchMs);
  }
  check() {
    if (!this.running || !this.stream) return false;
    const now = this.now();
    if (!this.ready && now - this.openedAt >= this.snapshotMs) { this.fail("Waiting too long for a complete snapshot"); return false; }
    if (now - this.lastMessageAt >= this.silenceMs) { this.fail("The update stream stopped answering"); return false; }
    return true;
  }
  resume() { this.check(); }
  fail(reason) {
    if (!this.running || this.retryTimer !== null) return;
    this.ready = false; this.clearTimeoutFn(this.watchTimer); this.watchTimer = null;
    const stream = this.stream; this.stream = null; stream?.close();
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMaxMs, this.retryMs * 2);
    this.retryTimer = this.setTimeoutFn(() => this.connect(), delay);
    this.onDisconnect(reason);
  }
  receive(type, raw) {
    let data;
    try { data = JSON.parse(raw); } catch { this.fail("Invalid update stream message"); return; }
    if (!object(data)) { this.fail("Invalid update stream message"); return; }
    // A duplicate or late revision is harmless and must not roll back data or
    // prolong the life of a stream that is only replaying old messages.
    if (type !== "heartbeat" && revisionNumber(data.revision) &&
      (data.revision < this.revision || (data.revision === this.revision && type !== "freshness"))) return;
    if (!timestamp(data.sentAt) || (type !== "heartbeat" && !revisionNumber(data.revision))) {
      this.fail("Invalid update stream envelope"); return;
    }
    const clock = this.getClock();
    if (clock && timestamp(clock.now) && Number.isFinite(clock.uncertaintyMs) && clock.uncertaintyMs >= 0 && clock.uncertaintyMs <= 5000 &&
      clock.now - data.sentAt > this.maxLagMs + Math.max(1000, clock.uncertaintyMs * 2)) {
      this.fail("Updates arrived too far behind the live stream"); return;
    }
    const valid = type === "heartbeat" || (type === "snapshot" ? Array.isArray(data.games) && object(data.sources)
      : type === "freshness" ? object(data.sources)
      : type === "status" ? object(data.source) && typeof data.source.book === "string"
      : Array.isArray(data.upsertGames) && Array.isArray(data.removeGameIds) && object(data.source) && typeof data.source.book === "string");
    if (!valid) { this.fail("Incomplete update stream message"); return; }
    this.lastMessageAt = this.now();
    if (type === "heartbeat") return;
    // A heartbeat, freshness notice or delta is not a replacement for a board.
    if (!this.ready && type !== "snapshot") return;
    try { this.onEvent(type, data); }
    catch { this.fail("Unable to apply an update; requesting a complete snapshot"); return; }
    this.revision = data.revision;
    if (type === "snapshot") { this.ready = true; this.retryMs = this.retryMinMs; }
  }
}

/** Keep the last good calibration through temporary failures. Even a fetch or
 * body reader that ignores abort cannot hold the synchronization promise open. */
export class ClockSync {
  constructor({ fetchFn = (...args) => fetch(...args), url = "/api/time", wallNow = () => Date.now(), now = () => performance.now(),
    setTimeoutFn = (callback, delay) => setTimeout(callback, delay), clearTimeoutFn = id => clearTimeout(id), samples = 5, timeoutMs = 4000,
    maxAgeMs = 120000, onSync = () => {} } = {}) {
    Object.assign(this, { fetchFn, url, wallNow, now, setTimeoutFn, clearTimeoutFn, samples, timeoutMs, maxAgeMs, onSync });
    this.inFlight = null; this.calibration = null; this.cancelRequest = null; this.stopped = false;
  }
  sync() {
    if (this.stopped) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.measure().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async request() {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((resolve, reject) => {
      this.cancelRequest = () => { controller.abort(); reject(new Error("Clock request cancelled")); };
      timer = this.setTimeoutFn(this.cancelRequest, this.timeoutMs);
    });
    const request = (async () => {
      const response = await this.fetchFn(this.url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Clock request failed");
      const body = await response.json();
      if (!timestamp(body?.now)) throw new Error("Invalid server clock");
      return body.now;
    })();
    try { return await Promise.race([request, timeout]); }
    finally { this.clearTimeoutFn(timer); this.cancelRequest = null; }
  }
  async measure() {
    let best = null;
    for (let i = 0; i < this.samples && !this.stopped; i++) {
      const wallStart = this.wallNow(), start = this.now();
      try {
        const serverTime = await this.request(), rtt = this.now() - start, wallElapsed = this.wallNow() - wallStart;
        if (this.stopped || !Number.isFinite(rtt) || rtt < 0 || rtt > this.timeoutMs || Math.abs(wallElapsed - rtt) > 1000) continue;
        if (!best || rtt < best.rtt) best = { rtt, offset: serverTime - (wallStart + rtt / 2),
          serverAt: serverTime + rtt / 2, measuredAt: this.now() };
      } catch { /* Optional calibration never blocks stream recovery. */ }
    }
    if (best && !this.stopped) { this.calibration = best; this.onSync(best); }
    return this.stopped ? null : best;
  }
  estimate() {
    const c = this.calibration;
    if (!c || this.stopped || this.now() - c.measuredAt > this.maxAgeMs) return null;
    // A laptop clock adjustment after calibration must not make current frames
    // look delayed. Advance the calibrated server time using the monotonic clock.
    return { now: c.serverAt + this.now() - c.measuredAt, uncertaintyMs: c.rtt / 2 };
  }
  stop() { this.stopped = true; this.cancelRequest?.(); }
}
