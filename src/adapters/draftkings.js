import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { makeGame, makeQuote } from "../model.js";
import { fetchJson, retryDelay } from "../http.js";

const eventFilter =
  "$filter=leagueId eq '88808' AND clientMetadata/Subcategories/any(s: s/Id eq '4518')";
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
export function subscription(id) {
  return {
    jsonrpc: "2.0",
    method: "subscribe",
    id,
    params: {
      entity: "events",
      queryParams: {
        query: eventFilter + " and tags/any(t: t eq 'OSB')",
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
export async function fetchDraftKingsSnapshot() {
  return fetchJson(DK_SNAPSHOT, {
    headers: {
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
    },
  });
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
      if (
        event.leagueId !== "88808" ||
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
          ),
        );
      } catch (e) {
        warnings.push(e.message);
      }
    }
    const types = { "1_0": "moneyline", "2_0": "spread", "3_0": "total" };
    for (const s of this.selections.values()) {
      const market = this.markets.get(s.marketId),
        game = games.get(market?.eventId);
      const kind = types[market?.marketType?.id];
      if (!game || !kind || market.subcategoryId !== "4518") continue;
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
  constructor(sink, { snapshotMs = 60000, socketUrl = DK_SOCKET } = {}) {
    this.sink = sink;
    this.snapshotMs = snapshotMs;
    this.socketUrl = socketUrl;
    this.stopped = true;
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    clearInterval(this.refresh);
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
    this.syncing = false;
    this.subscribed = false;
    this.awaitingPong = false;
    const id = randomUUID();
    ws.on("open", () => {
      ws.send(JSON.stringify(subscription(id)));
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
      this.awaitingPong = false;
      if (this.state && !this.syncing) this.sink.confirm("draftkings");
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
        if (message.id !== id) return;
        if (message.event === "subscribed") {
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
            if (this.buffer.length > 10000)
              throw new Error("Stream buffer limit exceeded");
            this.buffer.push(update);
          } else this.consume(update);
        } else if (message.event === "unsubscribed")
          throw new Error("DraftKings subscription ended");
      } catch (error) {
        this.fail(ws, error);
        ws.terminate();
      }
    });
    ws.on("error", (error) => {
      if (!this.stopped) this.fail(ws, error);
    });
    ws.on("close", () => {
      clearInterval(this.heartbeat);
      clearInterval(this.refresh);
      if (this.stopped || ws !== this.ws) return;
      this.sink.failure(
        "draftkings",
        ws.failureReason ??
          new Error("Stream disconnected; reconnecting and rebuilding state"),
      );
      this.retry = setTimeout(
        () => this.connect(),
        retryDelay((this.failures = (this.failures || 0) + 1), ws.failureReason),
      );
    });
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
    try {
      const result = await fetchDraftKingsSnapshot();
      if (this.stopped || ws !== this.ws || ws.readyState !== WebSocket.OPEN)
        return;
      const next = new DraftKingsState();
      next.replace(result.data);
      // Subscribe before fetching. Replay all buffered deltas before exposing the refreshed state.
      for (const item of this.buffer) next.apply(item.delta);
      this.state = next;
      this.buffer = [];
      this.failures = 0;
      this.sink.update("draftkings", next.normalize(), {
        ...result,
        data: undefined,
        kind: "snapshot",
      });
    } catch (error) {
      if (this.stopped || ws !== this.ws) return;
      this.fail(ws, error);
      ws.terminate();
    } finally {
      if (ws === this.ws) this.syncing = false;
    }
  }
}
