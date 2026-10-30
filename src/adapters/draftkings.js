import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { makeGame, makeQuote } from "../model.js";
import { fetchJson, retryDelay } from "../http.js";
import { fetchCurlJson } from "../curl-http.js";
import { CurlJsonBatchClient } from "../curl-batch-http.js";
import { DRAFTKINGS_LEAGUES, leagueForDraftKings } from "../leagues.js";

const eventsForLeague = leagueId =>
  `$filter=leagueId eq '${leagueId}' AND clientMetadata/Subcategories/any(s: s/Id eq '4518')`;
const eventFilter = eventsForLeague("88808");
const marketFilter =
  "$filter=clientMetadata/subCategoryId eq '4518' AND tags/all(t: t ne 'SportcastBetBuilder')";
export const DK_SNAPSHOT =
  "https://sportsbook-nash.draftkings.com/sites/CA-ON-SB/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?" +
  new URLSearchParams({
    isBatchable: "false",
    templateVars: "88808",
    eventsQuery: eventFilter,
    marketsQuery: marketFilter,
    include: "Events",
    entity: "events",
  });
export const DK_SOCKET =
  "wss://sportsbook-ws-ca-on.draftkings.com/websocket?format=json&locale=en";
export function snapshotUrl(leagueId) {
  if (!leagueForDraftKings(leagueId)) throw new Error("Unsupported DraftKings league");
  const url = new URL(DK_SNAPSHOT);
  url.searchParams.set("templateVars", String(leagueId));
  url.searchParams.set("eventsQuery", eventsForLeague(leagueId));
  return url.href;
}
export function subscription(id, leagueId = "88808") {
  if (!leagueForDraftKings(leagueId)) throw new Error("Unsupported DraftKings league");
  return {
    jsonrpc: "2.0",
    method: "subscribe",
    id,
    params: {
      entity: "events",
      queryParams: {
        query: eventsForLeague(leagueId) + " and tags/any(t: t eq 'OSB')",
        initialData: false,
        projection: "sportsbook",
        locale: "en",
        includeMarkets: marketFilter + " and tags/any(t: t eq 'OSB')",
      },
      forwardedHeaders: {},
      clientMetadata: {
        feature: "league",
        "X-Client-Name": "web",
        "X-Client-Version": "2643.4.1.10",
      },
      jwt: "default-token",
      siteName: "dkcaon",
    },
  };
}
export const DK_HEADERS = {
  origin: "https://sportsbook.draftkings.com",
  referer: "https://sportsbook.draftkings.com/",
  "content-type": "application/json charset=utf-8",
  "x-client-feature": "leagueSubcategory",
  "x-client-name": "web",
  "x-client-page": "league",
  "x-client-version": "2643.4.1.10",
  "x-client-widget-name": "cms",
  "x-client-widget-version": "3.1.1",
  "x-pe-cn": "web",
  "x-pe-cv": "2643.4.1.10",
  "x-pe-ep": "SB",
  "x-pe-loc": "CA-ON",
};
export async function fetchDraftKingsSnapshot({ signal, leagueId = "88808" } = {}) {
  const transport = process.env.DK_HTTP_TRANSPORT || (process.env.RENDER === "true" ? "curl" : "native");
  if (!["native", "curl"].includes(transport)) throw new Error("Unknown DK_HTTP_TRANSPORT");
  const fetcher = transport === "curl" ? fetchCurlJson : fetchJson;
  return fetcher(snapshotUrl(leagueId), { headers: DK_HEADERS, signal });
}

// A single atomic baseline for every subscribed league. The anonymous HTTP
// session is owned by this collector, reused while active, and retired on abort.
// No failed or missing league is represented as a successful empty response.
export class DraftKingsSnapshotClient {
  constructor({ transport = process.env.DK_HTTP_TRANSPORT || (process.env.RENDER === "true" ? "curl" : "native"),
    client = null, nativeFetch = fetchJson, leagueIds = DRAFTKINGS_LEAGUES.map(x => x.sourceId) } = {}) {
    if (!["native", "curl"].includes(transport)) throw new Error("Unknown DK_HTTP_TRANSPORT");
    this.transport = transport; this.client = client; this.nativeFetch = nativeFetch;
    this.requests = leagueIds.map(id => ({ id, url: snapshotUrl(id) }));
    if (!this.requests.length || new Set(leagueIds).size !== leagueIds.length) throw new Error("Invalid DraftKings league scope");
  }
  async fetch({ signal } = {}) {
    const began = performance.now();
    const deadline = AbortSignal.timeout(15000);
    const batchController = new AbortController();
    const requestSignal = AbortSignal.any([deadline, batchController.signal, ...(signal ? [signal] : [])]);
    let responses;
    if (this.transport === "curl") {
      this.client ??= new CurlJsonBatchClient();
      responses = await this.client.fetch(this.requests, { headers: DK_HEADERS, signal: requestSignal });
    } else {
      // Small requests in parallel keep a slow auxiliary league from serially
      // adding to native acquisition time. Publish only the complete result.
      const pending = this.requests.map(async request => ({ id: request.id,
        ...await this.nativeFetch(request.url, { headers: DK_HEADERS, signal: requestSignal }) }));
      try {
        responses = await Promise.all(pending);
      } catch (error) {
        // A denied league invalidates the whole baseline. Retire its siblings
        // before reconnecting so unsuccessful native batches cannot overlap.
        batchController.abort(error);
        await Promise.allSettled(pending);
        throw error;
      }
    }
    if (responses.length !== this.requests.length) throw new Error("DraftKings snapshot omitted a league");
    const merged = { events: new Map(), markets: new Map(), selections: new Map() };
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      if (response.id !== this.requests[i].id) throw new Error("DraftKings snapshot league identity mismatch");
      for (const kind of Object.keys(merged)) {
        if (!Array.isArray(response.data?.[kind])) throw new Error(`DraftKings ${kind} schema changed`);
        for (const item of response.data[kind]) {
          if (!item?.id || merged[kind].has(item.id)) throw new Error(`Duplicate or missing DraftKings ${kind} identity`);
          if (kind === "events" && String(item.leagueId) !== response.id) throw new Error("DraftKings returned the wrong league");
          merged[kind].set(item.id, item);
        }
      }
    }
    return { data: Object.fromEntries(Object.entries(merged).map(([kind, map]) => [kind, [...map.values()]])),
      receivedAt: Math.min(...responses.map(r => r.receivedAt)), durationMs: performance.now() - began,
      decodedBytes: responses.reduce((n, r) => n + r.decodedBytes, 0),
      wireBytes: responses.every(r => Number.isFinite(r.wireBytes)) ? responses.reduce((n, r) => n + r.wireBytes, 0) : null };
  }
  close() { this.client?.close(); this.client = null; }
}
export class DraftKingsState {
  replace(data) {
    for (const type of ["events", "markets", "selections"]) {
      if (!Array.isArray(data?.[type]) || data[type].some((x) => !x?.id))
        throw new Error(`DraftKings ${type} schema changed`);
    }
    this.events = new Map(data.events.map((x) => [x.id, x]));
    this.markets = new Map(data.markets.map((x) => [x.id, x]));
    this.selections = new Map(data.selections.map((x) => [x.id, x]));
  }
  apply(delta) {
    if (
      !delta ||
      !["add", "change", "remove"].every(
        (k) => delta[k] && typeof delta[k] === "object",
      )
    )
      throw new Error("DraftKings delta schema changed");
    for (const type of ["events", "markets", "selections"]) {
      for (const op of ["add", "change", "remove"])
        if (!Array.isArray(delta[op][type]))
          throw new Error(`Malformed ${type} delta`);
      for (const id of delta.remove[type])
        this[type].delete(typeof id === "string" ? id : id.id);
      for (const item of delta.add[type]) {
        if (!item?.id) throw new Error("Delta addition has no ID");
        this[type].set(item.id, item);
      }
      for (const item of delta.change[type]) {
        const old = this[type].get(item.id);
        if (!old)
          throw new Error(`Change for unknown ${type} ID; resnapshot required`);
        // Delta fields are partial. A price-only change must preserve marketId and side.
        this[type].set(item.id, { ...old, ...item });
      }
    }
    for (const [id, m] of this.markets)
      if (!this.events.has(m.eventId)) this.markets.delete(id);
    for (const [id, s] of this.selections)
      if (!this.markets.has(s.marketId)) this.selections.delete(id);
  }
  normalize() {
    const games = new Map(),
      quotes = [],
      warnings = [];
    for (const event of this.events.values()) {
      const league = leagueForDraftKings(event.leagueId);
      if (
        !league ||
        ["FINISHED", "CANCELLED", "ENDED"].includes(event.status)
      )
        continue;
      const away = event.participants?.find((t) => t.venueRole === "Away");
      const home = event.participants?.find((t) => t.venueRole === "Home");
      try {
        games.set(
          event.id,
          makeGame(
            "draftkings",
            event.id,
            away?.name,
            home?.name,
            event.startEventDate,
            ["STARTED", "IN_PROGRESS", "LIVE"].includes(event.status),
            league,
          ),
        );
      } catch (e) {
        warnings.push(e.message);
      }
    }
    const types = { "1_0": "moneyline", "2_0": "spread", "3_0": "total" };
    // Ontario replaces pregame market IDs at kickoff. These explicitly observed
    // live types still describe the primary full-game contracts in subcategory 4518;
    // other suffixes can be a half/quarter or another settlement and are excluded.
    const liveTypes = { "1_39": "moneyline", "2_39": "spread", "3_39": "total" };
    const kinds = new Map();
    for (const market of this.markets.values()) {
      const game = games.get(market.eventId);
      if (!game || market.subcategoryId !== "4518") continue;
      const type = market.marketType?.id;
      let kind = types[type];
      if (liveTypes[type] && game.live && market.tags?.includes("PrimaryMarket") &&
          market.name?.toLowerCase() === liveTypes[type] && market.marketType.name?.toLowerCase() === liveTypes[type])
        kind = liveTypes[type];
      if (kind) kinds.set(market.id, kind);
      else if (market.tags?.includes("PrimaryMarket") && ["moneyline", "spread", "total"].includes(market.name?.toLowerCase()))
        warnings.push(`Unsupported DraftKings primary market ${type ?? "unknown"} for event ${market.eventId}`);
    }
    for (const s of this.selections.values()) {
      const market = this.markets.get(s.marketId),
        game = games.get(market?.eventId);
      const kind = kinds.get(market?.id);
      if (!game || !kind) continue;
      if (kind !== "moneyline" && !s.tags?.includes("MainPointLine")) continue;
      const suspended =
        s.isSuspended === true ||
        market.isSuspended === true ||
        ["SUSPENDED", "CLOSED"].includes(market.status) ||
        s.isOpen === false;
      try {
        quotes.push(
          makeQuote(
            game,
            kind,
            s.outcomeType?.toLowerCase(),
            s.points,
            s.displayOdds?.american,
            s.id,
            suspended,
          ),
        );
      } catch (e) {
        warnings.push(e.message);
      }
    }
    if (this.events.size && !games.size)
      throw new Error("DraftKings returned no recognizable games");
    if (this.selections.size && !quotes.length)
      throw new Error("DraftKings returned no valid main-market selections");
    return { games: [...games.values()], quotes, warnings };
  }
}

export class DraftKings {
  constructor(sink, { snapshotMs = 60000, socketUrl = DK_SOCKET, snapshotFetch = null,
    leagueIds = DRAFTKINGS_LEAGUES.map(x => x.sourceId), maxBufferedBytes = 16 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1 || maxBufferedBytes > 16 * 1024 * 1024)
      throw new Error("Invalid DraftKings stream buffer byte limit");
    this.sink = sink;
    this.snapshotMs = snapshotMs;
    this.socketUrl = socketUrl;
    this.leagueIds = leagueIds;
    this.maxBufferedBytes = maxBufferedBytes;
    this.snapshotClient = snapshotFetch ? null : new DraftKingsSnapshotClient({ leagueIds });
    this.snapshotFetch = snapshotFetch ?? (options => this.snapshotClient.fetch(options));
    this.stopped = true;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    clearInterval(this.refresh);
    this.snapshotController?.abort();
    this.snapshotClient?.close();
    this.buffer = [];
    this.bufferBytes = 0;
    this.ws?.terminate();
  }
  connect() {
    if (this.stopped) return;
    const ws = (this.ws = new WebSocket(this.socketUrl, {
      handshakeTimeout: 10000,
      maxPayload: 8 * 1024 * 1024,
    }));
    this.state = null;
    this.buffer = [];
    this.bufferBytes = 0;
    this.syncing = false;
    this.subscribed = false;
    this.subscriptions = new Map(this.leagueIds.map(leagueId => [randomUUID(), { leagueId, acknowledged: false }]));
    this.awaitingPong = false;
    ws.on("open", () => {
      if (this.stopped || ws !== this.ws) { ws.terminate(); return; }
      for (const [id, { leagueId }] of this.subscriptions) ws.send(JSON.stringify(subscription(id, leagueId)));
      this.heartbeat = setInterval(() => {
        if (this.awaitingPong || !this.subscribed) {
          this.fail(
            ws,
            new Error("Stream heartbeat or subscription timeout"),
          );
          ws.terminate();
          return;
        }
        this.awaitingPong = true;
        ws.ping();
      }, 10000);
    });
    ws.on("pong", () => {
      if (ws !== this.ws || this.stopped) return;
      this.awaitingPong = false;
      if (this.state) this.sink.confirm("draftkings");
    });
    ws.on("message", (raw) => {
      if (ws !== this.ws || this.stopped) return;
      const receivedAt = Date.now();
      try {
        const message = JSON.parse(raw.toString());
        if (message.error)
          throw new Error(
            `DraftKings subscription error: ${message.error.message ?? message.error.code}`,
          );
        const subscribedLeague = this.subscriptions.get(message.id);
        if (!subscribedLeague) return;
        if (message.event === "subscribed") {
          if (subscribedLeague.acknowledged) throw new Error("DraftKings duplicated subscription acknowledgement");
          subscribedLeague.acknowledged = true;
          if (![...this.subscriptions.values()].every(x => x.acknowledged)) return;
          this.subscribed = true;
          void this.resnapshot(ws);
          this.refresh = setInterval(
            () => void this.resnapshot(ws),
            this.snapshotMs,
          );
        } else if (message.event === "update") {
          const update = {
            delta: message.data?.data,
            meta: {
              receivedAt,
              kind: "stream",
              decodedBytes: raw.length,
              sourceCreatedAt:
                Date.parse(message.data?.metadata?.createdTime) || null,
              sourcePublishedAt:
                Date.parse(message.websocketPublishTimestamp) || null,
            },
          };
          if (!this.state || this.syncing) {
            if (this.buffer.length >= 10000 || this.bufferBytes + raw.length > this.maxBufferedBytes)
              throw new Error("Stream buffer limit exceeded");
            this.buffer.push(update);
            this.bufferBytes += raw.length;
          }
          // A periodic snapshot must not delay prices already arriving on the
          // stream. Keep serving the current state while buffering for its replacement.
          if (this.state) this.consume(update);
        } else if (message.event === "unsubscribed")
          throw new Error("DraftKings subscription ended");
      } catch (error) {
        this.fail(ws, error);
        ws.terminate();
      }
    });
    ws.on("error", (error) => {
      if (!this.stopped && ws === this.ws) this.fail(ws, error);
    });
    ws.on("close", () => {
      if (ws !== this.ws) return;
      clearInterval(this.heartbeat);
      clearInterval(this.refresh);
      this.buffer = [];
      this.bufferBytes = 0;
      if (this.stopped || ws !== this.ws) return;
      this.snapshotController?.abort();
      this.sink.failure(
        "draftkings",
        ws.failureReason ??
          new Error("Stream disconnected; reconnecting and rebuilding state"),
      );
      this.retry = setTimeout(
        () => this.connect(),
        this.reconnectDelay(ws.failureReason),
      );
    });
  }
  reconnectDelay(error) {
    this.failures = (this.failures || 0) + 1;
    this.lastFailureAt = Date.now();
    // One isolated transport close can recover promptly. Repeated failures and
    // HTTP denials keep exponential backoff and Retry-After intact.
    const handshakeStatus = /^Unexpected server response: (\d{3})$/.exec(error?.message ?? "")?.[1];
    return this.failures === 1 && !error?.status && !handshakeStatus && !error?.retryAfterMs
      ? 250 + Math.random() * 50 : retryDelay(this.failures, error);
  }
  fail(ws, error) {
    // A subsequent close event must not replace the actionable handshake/snapshot error.
    ws.failureReason = error;
    this.sink.failure("draftkings", error);
  }
  consume(update) {
    this.state.apply(update.delta);
    this.sink.update("draftkings", this.state.normalize(), update.meta);
  }
  async resnapshot(ws) {
    if (this.syncing || !this.subscribed || ws !== this.ws) return;
    this.syncing = true;
    const controller = (this.snapshotController = new AbortController());
    try {
      const result = await this.snapshotFetch({ signal: controller.signal });
      if (this.stopped || ws !== this.ws || ws.readyState !== WebSocket.OPEN)
        return;
      const next = new DraftKingsState();
      next.replace(result.data);
      // Subscribe before fetching. Replay all buffered deltas before exposing the refreshed state.
      for (const item of this.buffer) next.apply(item.delta);
      this.state = next;
      this.buffer = [];
      this.bufferBytes = 0;
      if (!this.lastFailureAt || Date.now() - this.lastFailureAt >= 30000) this.failures = 0;
      this.sink.update("draftkings", next.normalize(), {
        ...result,
        data: undefined,
        kind: "snapshot",
      });
    } catch (error) {
      if (controller.signal.aborted || this.stopped || ws !== this.ws) return;
      this.fail(ws, error);
      ws.terminate();
    } finally {
      if (ws === this.ws) this.syncing = false;
    }
  }
}
