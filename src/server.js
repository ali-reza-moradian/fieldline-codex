import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OddsStore } from "./store.js";
import { Metrics } from "./metrics.js";
import { DraftKings } from "./adapters/draftkings.js";
import { FanDuel } from "./adapters/fanduel.js";
import { ExtrasService } from "./extras-service.js";
import { PriceHistory } from "./price-history.js";
import { HistoryPersistence } from "./history-persistence.js";

// Counters and timestamps stay available in snapshots and /api/metrics. Only
// fields that change how a source can be displayed or trusted need a full frame.
const sourcePresentation = (source) => JSON.stringify({
  book: source.book, status: source.status, error: source.error,
  warnings: source.warnings, games: source.games, quotes: source.quotes,
  transport: source.transport, region: source.region, pollMs: source.pollMs,
  staleAfterMs: source.staleAfterMs, coverage: source.coverage, endpoints: source.endpoints,
  push: source.channels?.push && {
    status: source.channels.push.status, error: source.channels.push.error,
    generation: source.channels.push.generation, verified: source.channels.push.verified,
    subscribedMarkets: source.channels.push.subscribedMarkets,
    region: source.channels.push.region, origin: source.channels.push.origin,
    endpoint: source.channels.push.endpoint,
  },
  polling: source.channels?.polling && {
    error: source.channels.polling.error, intervalMs: source.channels.polling.intervalMs,
  },
  discovery: source.channels?.discovery && { error: source.channels.discovery.error },
});

export function createApp({
  store = new OddsStore(),
  metrics = new Metrics(),
  ingest = true,
  collectorFactory = (sink) => [new DraftKings(sink), new FanDuel(sink)],
  streamScheduler = { setInterval, clearInterval },
  extrasFactory = options => new ExtrasService(options),
  priceHistory = new PriceHistory(),
  persistenceFactory = options => new HistoryPersistence(options),
} = {}) {
  const clients = new Set();
  const extras = extrasFactory({ store });
  const files = new Map([
    ["/", ["../public/index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["../public/app.js", "text/javascript; charset=utf-8"]],
    ["/presentation.js", ["../public/presentation.js", "text/javascript; charset=utf-8"]],
    ["/stream.js", ["../public/stream.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["../public/style.css", "text/css; charset=utf-8"]],
    ["/model.js", ["./model.js", "text/javascript; charset=utf-8"]],
    ["/analytics.js", ["./analytics.js", "text/javascript; charset=utf-8"]],
    ["/ui-controls.js", ["../public/ui-controls.js", "text/javascript; charset=utf-8"]],
    ["/extras-panel.js", ["../public/extras-panel.js", "text/javascript; charset=utf-8"]],
  ]);
  const security = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
  };
  const serialize = (type, data) =>
    `${Number.isInteger(data.revision) ? `id: ${data.revision}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const write = (client, frame, bytes = Buffer.byteLength(frame)) => {
    if (client.destroyed || client.writableEnded || client.writableLength + bytes > 256 * 1024) {
      client.destroy();
      clients.delete(client);
      return;
    }
    try { client.write(frame); }
    catch { client.destroy(); clients.delete(client); }
  };
  const send = (res, type, data) => write(res, serialize(type, data));
  const broadcast = (type, data) => {
    const frame = serialize(type, data);
    const bytes = Buffer.byteLength(frame);
    for (const client of clients) write(client, frame, bytes);
  };
  const presentations = new Map(Object.entries(store.sources).map(([book, source]) => [book, sourcePresentation(source)]));
  let freshnessPending = false;
  const onMessage = ({ type, data }) => {
    if (data.source) {
      const signature = sourcePresentation(data.source);
      const changed = presentations.get(data.source.book) !== signature;
      presentations.set(data.source.book, signature);
      if (type === "status" && !changed) {
        freshnessPending = true;
        return;
      }
    }
    broadcast(type, data);
  };
  store.on("message", onMessage);
  const detachHistory = priceHistory.attach(store);
  const persistence = persistenceFactory({ history: priceHistory, connectionString: process.env.HISTORY_DATABASE_URL });
  persistence.start();
  const freshness = streamScheduler.setInterval(() => {
    if (!freshnessPending) return;
    freshnessPending = false;
    if (!clients.size) return;
    // Read current state at flush time: a status queued before a newer delta
    // must never send the delta's older source timestamps afterwards.
    broadcast("freshness", {
      revision: store.revision, sentAt: Date.now(),
      sources: Object.fromEntries(Object.entries(store.sources).map(([book, source]) => [book, {
        lastConfirmedAt: source.lastConfirmedAt,
        lastDataAt: source.lastDataAt,
        lastChangeAt: source.lastChangeAt,
      }])),
    });
  }, 250);
  freshness.unref?.();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, data) => {
      res.writeHead(status, {
        ...security,
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === "GET" && url.pathname === "/api/history") {
        const gameId = url.searchParams.get("gameId"), market = url.searchParams.get("market"), side = url.searchParams.get("side");
        if (!gameId || gameId.length > 150 || !['moneyline','spread','total'].includes(market) ||
          !(market === 'total' ? ['over','under'] : ['home','away']).includes(side))
          return json(400, { error: "A gameId, market and matching side are required" });
        try { return json(200, { ...priceHistory.query({ gameId, market, side,
          hours: url.searchParams.has('hours') ? Number(url.searchParams.get('hours')) : 48,
          maxPoints: url.searchParams.has('maxPoints') ? Number(url.searchParams.get('maxPoints')) : 3000 }),
          storage: persistence.status() }); }
        catch (error) { if (error instanceof RangeError || error instanceof TypeError) return json(400, { error: error.message }); throw error; }
      }
      if (req.method === "GET" && url.pathname === "/api/extras/events") {
        const gameId = url.searchParams.get("gameId");
        if (!gameId || gameId.length > 150) return json(400, { error: "A valid gameId is required" });
        if (extras.report().viewers >= 100) return json(503, { error: "Extra-market viewer capacity reached" });
        const watch = extras.watch(gameId, res);
        if (watch.status !== 200) return json(watch.status, { error: watch.error });
        res.writeHead(200, { ...security, "Cache-Control": "no-store, no-transform",
          "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders(); req.socket.setNoDelay(true);
        extras.write(res, serialize("snapshot", watch.snapshot));
        req.on("close", watch.release); res.on("close", watch.release);
        res.on("error", () => { watch.release(); res.destroy(); });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        if (clients.size >= 500)
          return json(503, { error: "Viewer capacity reached; retry shortly" });
        res.writeHead(200, {
          ...security,
          "Cache-Control": "no-store, no-transform",
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        req.socket.setNoDelay(true);
        clients.add(res);
        send(res, "snapshot", store.snapshot());
        req.on("close", () => clients.delete(res));
        res.on("close", () => clients.delete(res));
        res.on("error", () => { clients.delete(res); res.destroy(); });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/board")
        return json(200, store.snapshot());
      if (req.method === "GET" && url.pathname === "/api/time")
        return json(200, { now: Date.now() });
      if (req.method === "GET" && url.pathname === "/api/metrics")
        return json(200, {
          version: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
          ...metrics.report(store.history, store.sources),
          viewers: clients.size,
          extras: extras.report(),
          history: { ...priceHistory.limits(), retentionHours: 48, storage: persistence.status() },
        });
      if (req.method === "GET" && url.pathname === "/api/health") {
        const now = Date.now();
        const books = Object.fromEntries(Object.entries(store.sources).map(([book, source]) => {
          const ageMs = source.lastConfirmedAt ? now - source.lastConfirmedAt : null;
          const complete = book !== "fanduel" || (source.coverage?.requested > 0 &&
            source.coverage.returned === source.coverage.requested && source.coverage.missingIds?.length === 0);
          return [book, { region: source.region,
            fresh: source.status === "healthy" && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < source.staleAfterMs,
            complete, games: source.games, quotes: source.quotes, ageMs,
            pushVerified: source.channels?.push?.verified ?? null }];
        }));
        const ready = Object.values(books).every(b => b.fresh && b.complete && b.games > 0 && b.quotes > 0);
        return json(ready ? 200 : 503, { ready, books,
          version: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null });
      }
      if (req.method === "GET" && url.pathname === "/healthz")
        return json(200, {
          status: "running",
          sources: Object.fromEntries(
            Object.entries(store.sources).map(([k, s]) => [k, s.status]),
          ),
        });
      if (req.method === "POST" && url.pathname === "/api/telemetry") {
        if (req.headers["sec-fetch-site"] === "cross-site")
          return json(403, { error: "Cross-site telemetry rejected" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096)
            return json(413, { error: "Payload too large" });
        }
        let sample;
        try {
          sample = JSON.parse(body);
        } catch {
          return json(400, { error: "Invalid JSON" });
        }
        const accepted = metrics.recordBrowser(sample);
        return json(accepted ? 202 : 400, { accepted });
      }
      if (req.method !== "GET" || !files.has(url.pathname))
        return json(404, { error: "Not found" });
      const [path, type] = files.get(url.pathname);
      const content = await readFile(new URL(path, import.meta.url));
      res.writeHead(200, { ...security, "Content-Type": type });
      res.end(content);
    } catch (error) {
      console.error("Request failed:", error.message);
      if (!res.headersSent) json(500, { error: "Request failed" });
      else res.end();
    }
  });
  const heartbeat = streamScheduler.setInterval(() => {
    // Transport liveness only. This does not confirm either bookmaker or
    // advance the board revision, and it remains visible to EventSource users.
    if (clients.size) broadcast("heartbeat", { sentAt: Date.now() });
    extras.heartbeat();
  }, 2000);
  heartbeat.unref?.();
  const collectors = ingest ? collectorFactory(store) : [];
  for (const collector of collectors) collector.start();
  async function shutdown() {
    for (const collector of collectors) collector.stop();
    extras.stop();
    streamScheduler.clearInterval(heartbeat);
    streamScheduler.clearInterval(freshness);
    store.off("message", onMessage);
    detachHistory();
    for (const client of clients) client.end();
    await Promise.all([persistence.close(), new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    })]);
  }
  return { server, store, metrics, extras, shutdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3210);
  app.server.listen(port, process.env.HOST || "127.0.0.1", () =>
    console.log(`NFL Odds Board: http://localhost:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.shutdown();
      process.exit(0);
    });
}
