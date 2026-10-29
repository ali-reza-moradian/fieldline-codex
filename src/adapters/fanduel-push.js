import WebSocket from "ws";

// FanDuel's production bundle selects a distinct Canadian configuration.
// Never infer an arbitrary region hostname or fall back across jurisdictions.
const PROFILES = Object.freeze({
  on: Object.freeze({ site: "https://sportsbook.fanduel.ca", suffix: "ca", awsRegion: "ca-west-1" }),
  nj: Object.freeze({ site: "https://sportsbook.fanduel.com", suffix: "com", awsRegion: "us-east-2" }),
});
function profileFor(region) {
  if (!Object.hasOwn(PROFILES, region)) throw new Error("Unsupported FanDuel region; use on or nj");
  const profile = PROFILES[region];
  return { ...profile, endpoint: `https://pir.${region}.sportsbook.fanduel.${profile.suffix}/graphql`,
    websocketUrl: `wss://pir.${region}.sportsbook.fanduel.${profile.suffix}/graphql/realtime` };
}
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36";
// Field selection verified in FanDuel's public production bundle. This is the
// sportsbook market-price subscription, independent of account or betting APIs.
export const FD_PRICE_SUBSCRIPTION = `subscription OnUpdateMarketPrice($ids: [String!]!) {
  onUpdateMarketPrice(ids: $ids) {
    marketId marketStatus inplay updatedAt
    runnerDetails { selectionId handicap runnerStatus
      winRunnerOdds { americanDisplayOdds { americanOdds americanOddsInt }
        trueOdds { decimalOdds { decimalOdds } } }
    }
  }
}`;

export function parseFanDuelPushConfig(bundle, region = "on") {
  const profile = profileFor(region);
  const anchor = `aws_appsync_graphqlEndpoint:"https://pir.{REGION}.sportsbook.fanduel.${profile.suffix}/graphql"`;
  const offset = bundle.indexOf(anchor);
  if (offset < 0) throw new Error("FanDuel public push configuration was not found");
  const end = bundle.indexOf("},", offset);
  const block = bundle.slice(offset, Math.min(offset + 700, end < 0 ? bundle.length : end));
  const read = name => block.match(new RegExp(`${name}:"([^"\\n]+)"`))?.[1];
  const endpoint = read("aws_appsync_graphqlEndpoint");
  const websocketUrl = read("aws_appsync_wssEndpoint");
  const clientId = read("aws_appsync_clientId");
  if (read("aws_appsync_authenticationType") !== "PIR_AUTH_KEY" ||
      read("aws_appsync_region") !== profile.awsRegion ||
      websocketUrl?.replace("{REGION}", region) !== profile.websocketUrl ||
      !clientId || clientId.length > 200)
    throw new Error("FanDuel public push configuration has changed");
  return { endpoint: endpoint.replace("{REGION}", region),
    websocketUrl: websocketUrl.replace("{REGION}", region), clientId };
}

async function boundedText(url, signal, fetchImpl, limit) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`FanDuel public configuration HTTP ${response.status}`); }
  const decoder = new TextDecoder(); let result = "", size = 0;
  for await (const chunk of response.body) {
    if ((size += chunk.length) > limit) throw new Error("FanDuel public configuration exceeded size limit");
    result += decoder.decode(chunk, { stream: true });
  }
  return result + decoder.decode();
}

export async function discoverFanDuelPushConfig({ region = "on", signal = new AbortController().signal, fetchImpl = fetch } = {}) {
  const { site } = profileFor(region);
  const shell = await boundedText(`${site}/sw.js`, signal, fetchImpl, 2 * 1024 * 1024);
  const path = shell.match(/\/static\/js\/main\.[\w-]+\.js/)?.[0];
  if (!path) throw new Error("FanDuel public app bundle was not found");
  const bundle = await boundedText(site + path, signal, fetchImpl, 12 * 1024 * 1024);
  return { ...parseFanDuelPushConfig(bundle, region), sourceUrl: site + path };
}

function validMarket(m) {
  if (!m || typeof m.marketId !== "string" ||
      (m.inplay !== undefined && typeof m.inplay !== "boolean") ||
      (m.marketStatus !== undefined && typeof m.marketStatus !== "string") ||
      (m.updatedAt != null && (typeof m.updatedAt !== "string" || !Number.isFinite(Date.parse(m.updatedAt))))) return false;
  if (m.marketStatus === "CLOSED" && !m.runnerDetails) return true;
  return Array.isArray(m.runnerDetails) && m.runnerDetails.length <= 100 &&
    (m.marketStatus !== "OPEN" || m.runnerDetails.length > 0) && m.runnerDetails.every(r => {
      if (!r || !["number", "string"].includes(typeof r.selectionId) ||
          String(r.selectionId).length === 0 || !Number.isFinite(Number(r.selectionId)) ||
          (r.handicap != null && (typeof r.handicap !== "number" || !Number.isFinite(r.handicap))) ||
          (r.runnerStatus !== undefined && typeof r.runnerStatus !== "string")) return false;
      const odds = r.winRunnerOdds;
      if (odds == null) return m.marketStatus !== "OPEN" || (r.runnerStatus !== undefined && r.runnerStatus !== "ACTIVE");
      if (typeof odds !== "object" || Array.isArray(odds)) return false;
      const displayed = odds.americanDisplayOdds;
      if (!displayed || typeof displayed !== "object") return false;
      const value = displayed.americanOddsInt ?? displayed.americanOdds;
      return ["number", "string"].includes(typeof value) && Number.isFinite(Number(value)) && Math.abs(Number(value)) >= 100;
    });
}

/** AppSync transport only. The collector owns the authoritative baseline and
 * ordering between push and polling; an acknowledgement supplies no prices. */
export class FanDuelPush {
  constructor({ onMarkets = () => {}, onState = () => {}, region = "on",
    fetchConfig = discoverFanDuelPushConfig, url, WebSocketImpl = WebSocket,
    ackTimeoutMs = 10000, heartbeatMs = 12000, pingMs = 5000,
    reconnectBaseMs = 1000, reconnectMaxMs = 30000, keyRefreshMs = 300000,
    configRetryMs = 30000, batchSize = 350, stableConnectionMs = 30000,
    protocolHeartbeatMs = 75000, maxProtocolHeartbeatMs = 120000, random = Math.random } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 350) throw new Error("Invalid FanDuel subscription batch size");
    this.profile = profileFor(region);
    Object.assign(this, { onMarkets, onState, region, fetchConfig, url, WebSocketImpl,
      ackTimeoutMs, heartbeatMs, pingMs, reconnectBaseMs, reconnectMaxMs,
      keyRefreshMs, configRetryMs, batchSize, stableConnectionMs,
      protocolHeartbeatMs, maxProtocolHeartbeatMs, random });
    this.stopped = true; this.generation = 0; this.run = 0; this.attempt = 0;
    this.ids = []; this.requested = new Set(); this.subscriptions = new Map();
    this.socketTimers = new Set(); this.sequence = 0;
    this.state = { status: "disconnected", lastConfirmedAt: null, lastDataAt: null,
      error: null, generation: 0, subscribedMarkets: 0,
      region, origin: this.profile.site, endpoint: this.profile.endpoint,
      lastProtocolAt: null, protocolTimeoutMs: Math.min(protocolHeartbeatMs, maxProtocolHeartbeatMs) };
    this.counters = { connections: 0, reconnects: 0, messages: 0, markets: 0,
      invalidFrames: 0, configReads: 0, authErrors: 0 };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false; this.run++; this.controller = new AbortController();
    void this.connect();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.run++; this.controller.abort();
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    this.dropSocket(); this.emit("disconnected", { error: null, subscribedMarkets: 0 });
  }
  setMarketIds(ids) {
    const next = [...new Set(ids.map(String))].filter(id => /^\d+\.\d+$/.test(id)).sort();
    if (next.length !== new Set(ids.map(String)).size) throw new Error("Invalid FanDuel market ID");
    if (next.join(",") === this.ids.join(",")) return;
    this.ids = next; this.requested = new Set(next);
    if (this.acknowledged) this.subscribe();
  }
  emit(status, patch = {}) {
    Object.assign(this.state, patch, { status, generation: this.generation });
    this.onState({ ...this.state, counters: { ...this.counters } });
  }
  timer(fn, ms) {
    const timer = setTimeout(() => { this.socketTimers.delete(timer); fn(); }, ms);
    this.socketTimers.add(timer); return timer;
  }
  clearTimer(timer) { clearTimeout(timer); this.socketTimers.delete(timer); }
  dropSocket() {
    const socket = this.ws; this.ws = null; this.acknowledged = false;
    for (const timer of this.socketTimers) clearTimeout(timer);
    this.socketTimers.clear(); this.subscriptions.clear(); this.pending = null;
    if (socket) socket.terminate();
  }
  fail(message, { auth = false, delay = 0 } = {}) {
    if (this.stopped) return;
    if (auth) { this.counters.authErrors++; this.refreshRequired = true; }
    this.emit("error", { error: message, subscribedMarkets: 0 });
    this.dropSocket();
    if (this.reconnectTimer) return;
    const backoff = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.attempt++, 6));
    const refreshWait = this.refreshRequired && this.lastAuthRefreshAt
      ? Math.max(0, this.lastAuthRefreshAt + this.keyRefreshMs - Date.now()) : 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) { this.counters.reconnects++; void this.connect(); }
    }, Math.max(delay, refreshWait, backoff * (1 + this.random() * .2)));
  }
  async connect() {
    if (this.stopped || this.ws) return;
    const run = this.run;
    this.emit("connecting", { error: null, subscribedMarkets: 0 });
    try {
      if (!this.config || this.refreshRequired) {
        if (this.refreshRequired) this.lastAuthRefreshAt = Date.now();
        this.counters.configReads++;
        const config = await this.fetchConfig({ region: this.region, signal: this.controller.signal });
        if (this.stopped || run !== this.run) return;
        if (!config?.clientId || config.endpoint !== this.profile.endpoint || config.websocketUrl !== this.profile.websocketUrl)
          throw new Error("FanDuel public push configuration does not match the requested region");
        this.config = config; this.refreshRequired = false;
      }
      if (this.stopped || run !== this.run) return;
      const auth = { Authorization: this.config.clientId, host: new URL(this.config.endpoint).host };
      const endpoint = new URL(this.url ?? this.config.websocketUrl);
      endpoint.searchParams.set("header", Buffer.from(JSON.stringify(auth)).toString("base64"));
      endpoint.searchParams.set("payload", Buffer.from("{}").toString("base64"));
      const socket = new this.WebSocketImpl(endpoint, ["graphql-ws"], {
        headers: { Origin: this.profile.site, "User-Agent": UA }, handshakeTimeout: this.ackTimeoutMs,
        maxPayload: 2 * 1024 * 1024, perMessageDeflate: false,
      });
      this.ws = socket; this.auth = auth; this.generation++; this.counters.connections++;
      const current = () => !this.stopped && this.ws === socket;
      socket.on("open", () => {
        if (!current()) return;
        this.lastSignalAt = this.openedAt = Date.now(); this.lastPingAt = 0;
        this.protocolTimeoutMs = Math.min(this.protocolHeartbeatMs, this.maxProtocolHeartbeatMs);
        this.lastProtocolAt = 0;
        socket.send(JSON.stringify({ type: "connection_init" }));
        this.connectionAckTimer = this.timer(() => this.fail("FanDuel push connection acknowledgement timed out"), this.ackTimeoutMs);
        const heartbeat = () => {
          if (!current()) return;
          if (Date.now() - this.lastSignalAt >= this.heartbeatMs) return this.fail("FanDuel push heartbeat timed out");
          // TCP pong proves the socket is reachable; AppSync keepalives or
          // valid subscription data separately prove its protocol is alive.
          if (this.acknowledged && Date.now() - this.lastProtocolAt >= this.protocolTimeoutMs)
            return this.fail("FanDuel push protocol heartbeat timed out");
          if (!this.lastPingAt || Date.now() - this.lastPingAt >= this.pingMs) { this.lastPingAt = Date.now(); socket.ping(); }
          this.timer(heartbeat, Math.max(1, Math.min(1000, this.pingMs, this.protocolTimeoutMs / 2)));
        };
        this.timer(heartbeat, Math.min(1000, this.pingMs));
      });
      socket.on("pong", () => { if (current()) this.confirm(); });
      socket.on("message", raw => { if (current()) this.message(raw); });
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        if (current()) this.fail(`FanDuel push HTTP ${response.statusCode}`, { auth: response.statusCode === 401 || response.statusCode === 403, delay: response.statusCode === 429 ? 30000 : 0 });
      });
      socket.on("error", () => { if (current()) this.fail("FanDuel push connection failed"); });
      socket.on("close", code => { if (current()) this.fail(`FanDuel push connection closed (${code})`); });
    } catch (error) {
      if (!this.stopped && run === this.run) this.fail(error.message, { delay: this.configRetryMs });
    }
  }
  confirm(protocol = false) {
    this.lastSignalAt = Date.now();
    if (protocol) this.lastProtocolAt = this.lastSignalAt;
    if (this.lastSignalAt - this.openedAt >= this.stableConnectionMs) this.attempt = 0;
    this.emit(this.state.status, { lastConfirmedAt: this.lastSignalAt,
      lastProtocolAt: this.lastProtocolAt || null, protocolTimeoutMs: this.protocolTimeoutMs });
  }
  subscribe() {
    if (!this.ws || !this.acknowledged) return;
    if (this.pending) for (const id of this.pending) {
      this.ws.send(JSON.stringify({ type: "stop", id }));
      this.clearTimer(this.subscriptions.get(id)?.timer); this.subscriptions.delete(id);
    }
    this.pending = new Set();
    this.emit("connecting", { subscribedMarkets: 0 });
    for (let index = 0; index < this.ids.length; index += this.batchSize) {
      const ids = this.ids.slice(index, index + this.batchSize), id = `${this.generation}:${++this.sequence}`;
      const timer = this.timer(() => this.fail("FanDuel push subscription acknowledgement timed out"), this.ackTimeoutMs);
      this.subscriptions.set(id, { ids, acknowledged: false, timer }); this.pending.add(id);
      this.ws.send(JSON.stringify({ type: "start", id,
        payload: { data: JSON.stringify({ query: FD_PRICE_SUBSCRIPTION, variables: { ids } }), extensions: { authorization: this.auth } } }));
    }
    if (!this.ids.length) {
      for (const [id, sub] of this.subscriptions) { this.ws.send(JSON.stringify({ type: "stop", id })); this.clearTimer(sub.timer); }
      this.subscriptions.clear(); this.pending = null;
    }
  }
  message(raw) {
    const receivedAt = Date.now(); this.counters.messages++;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { this.counters.invalidFrames++; return; }
    if (!message || typeof message !== "object") { this.counters.invalidFrames++; return; }
    if (["error", "connection_error"].includes(message.type)) {
      if (message.type === "error" && message.id && !this.subscriptions.has(message.id)) { this.counters.invalidFrames++; return; }
      const auth = /Unauthorized|UnauthorizedException|\b401\b|\b403\b/i.test(JSON.stringify(message.payload));
      return this.fail(auth ? "FanDuel public push key was rejected" : "FanDuel push subscription error", { auth });
    }
    if (message.type === "connection_ack") {
      this.clearTimer(this.connectionAckTimer); this.acknowledged = true;
      const advertised = message.payload?.connectionTimeoutMs;
      this.protocolTimeoutMs = Math.min(this.maxProtocolHeartbeatMs,
        Number.isFinite(advertised) && advertised > 0 ? advertised : this.protocolHeartbeatMs);
      this.confirm(true); this.subscribe(); return;
    }
    if (message.type === "ka") { this.confirm(true); return; }
    if (message.type === "start_ack") {
      const subscription = this.subscriptions.get(message.id);
      if (!subscription) return;
      subscription.acknowledged = true; this.clearTimer(subscription.timer); this.confirm(true);
      if (this.pending && [...this.pending].every(id => this.subscriptions.get(id)?.acknowledged)) {
        for (const [id, sub] of this.subscriptions) if (!this.pending.has(id)) {
          this.ws.send(JSON.stringify({ type: "stop", id })); this.clearTimer(sub.timer); this.subscriptions.delete(id);
        }
        this.pending = null;
        this.emit("subscribed", { error: null, subscribedMarkets: this.ids.length });
      }
      return;
    }
    if (message.type === "complete" && this.subscriptions.has(message.id)) return this.fail("FanDuel push subscription ended");
    if (message.type !== "data") { this.counters.invalidFrames++; return; }
    const subscription = this.subscriptions.get(message.id);
    const market = message.payload?.data?.onUpdateMarketPrice;
    if (!subscription?.acknowledged ||
        (typeof market?.marketId === "string" && (!this.requested.has(market.marketId) || !subscription.ids.includes(market.marketId)))) {
      this.counters.invalidFrames++; return;
    }
    if (!validMarket(market)) {
      this.counters.invalidFrames++;
      return this.fail("FanDuel push returned malformed market data");
    }
    this.confirm(true); this.counters.markets++;
    this.emit(this.state.status, { lastDataAt: receivedAt });
    try {
      this.onMarkets([market], { receivedAt, sourceUpdatedAt: market.updatedAt ? Date.parse(market.updatedAt) : null,
        decodedBytes: raw.length, generation: this.generation, kind: "push" });
    } catch {
      this.fail("FanDuel push consumer rejected the market update");
    }
  }
}
