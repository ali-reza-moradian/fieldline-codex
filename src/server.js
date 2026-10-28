import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OddsStore } from "./store.js";
import { Metrics } from "./metrics.js";
import { DraftKings } from "./adapters/draftkings.js";
import { FanDuel } from "./adapters/fanduel.js";

export function createApp({
  store = new OddsStore(),
  metrics = new Metrics(),
  ingest = true,
} = {}) {
  const clients = new Set();
  const files = new Map([
    ["/", ["../public/index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["../public/app.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["../public/style.css", "text/css; charset=utf-8"]],
    ["/model.js", ["./model.js", "text/javascript; charset=utf-8"]],
  ]);
  const security = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
  };
  const serialize = (type, data) =>
    `id: ${data.revision}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const send = (res, type, data) => res.write(serialize(type, data));
  const broadcast = ({ type, data }) => {
    const frame = serialize(type, data);
    for (const client of clients) {
      if (client.writableLength > 256 * 1024) {
        client.destroy();
        clients.delete(client);
        continue;
      }
      client.write(frame);
    }
  };
  store.on("message", broadcast);
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
      if (req.method === "GET" && url.pathname === "/api/events") {
        if (clients.size >= 500)
          return json(503, { error: "Viewer capacity reached; retry shortly" });
        res.writeHead(200, {
          ...security,
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        req.socket.setNoDelay(true);
        clients.add(res);
        send(res, "snapshot", store.snapshot());
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/board")
        return json(200, store.snapshot());
      if (req.method === "GET" && url.pathname === "/api/time")
        return json(200, { now: Date.now() });
      if (req.method === "GET" && url.pathname === "/api/metrics")
        return json(200, {
          ...metrics.report(store.history, store.sources),
          viewers: clients.size,
        });
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
        return json(metrics.recordBrowser(sample) ? 202 : 400, {
          accepted: true,
        });
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
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);
  heartbeat.unref();
  const collectors = ingest ? [new DraftKings(store), new FanDuel(store)] : [];
  for (const collector of collectors) collector.start();
  function shutdown() {
    for (const collector of collectors) collector.stop();
    clearInterval(heartbeat);
    store.off("message", broadcast);
    for (const client of clients) client.end();
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
  }
  return { server, store, metrics, shutdown };
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
