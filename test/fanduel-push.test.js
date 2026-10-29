import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { FanDuelPush, parseFanDuelPushConfig, discoverFanDuelPushConfig } from "../src/adapters/fanduel-push.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await pause(2); }
}
const config = (clientId, region = "on") => {
  const suffix = region === "on" ? "ca" : "com";
  return { endpoint: `https://pir.${region}.sportsbook.fanduel.${suffix}/graphql`,
    websocketUrl: `wss://pir.${region}.sportsbook.fanduel.${suffix}/graphql/realtime`, clientId };
};
const market = (marketId = "734.1") => ({ marketId, marketStatus: "OPEN", inplay: false,
  updatedAt: "2026-10-28T23:00:00Z", runnerDetails: [{ selectionId: 7, handicap: 3.5,
    runnerStatus: "ACTIVE", winRunnerOdds: { americanDisplayOdds: { americanOdds: "-110", americanOddsInt: -110 },
      trueOdds: { decimalOdds: { decimalOdds: 1.90909 } } } }] });
const send = (socket, message) => socket.send(JSON.stringify(message));

async function harness(t, { handler, serverOptions = {}, options = {} } = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", ...serverOptions });
  await once(server, "listening");
  const messages = [], sockets = [], states = [], updates = [];
  server.on("connection", (socket, request) => {
    sockets.push(socket);
    socket.on("message", raw => {
      const msg = JSON.parse(raw); messages.push({ socket, msg, request });
      if (handler) handler(socket, msg, request);
      else if (msg.type === "connection_init") send(socket, { type: "connection_ack" });
      else if (msg.type === "start") send(socket, { type: "start_ack", id: msg.id });
    });
  });
  const transport = new FanDuelPush({
    url: `ws://127.0.0.1:${server.address().port}/graphql/realtime`,
    fetchConfig: async () => config("test-public-client"),
    onState: value => states.push(value), onMarkets: (data, timing) => updates.push({ data, timing }),
    ackTimeoutMs: 100, heartbeatMs: 200, pingMs: 50, reconnectBaseMs: 10,
    reconnectMaxMs: 50, configRetryMs: 10, keyRefreshMs: 500, random: () => 0,
    ...options,
  });
  t.after(async () => { transport.stop(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { transport, messages, sockets, states, updates };
}

test("FanDuel selects Ontario's distinct public config and fetches the Canadian production bundle", async () => {
  const us = 'aws_appsync_graphqlEndpoint:"https://pir.{REGION}.sportsbook.fanduel.com/graphql",aws_appsync_wssEndpoint:"wss://pir.{REGION}.sportsbook.fanduel.com/graphql/realtime",aws_appsync_region:"us-east-2",aws_appsync_authenticationType:"PIR_AUTH_KEY",aws_appsync_clientId:"test-us-client"';
  const ca = 'aws_appsync_graphqlEndpoint:"https://pir.{REGION}.sportsbook.fanduel.ca/graphql",aws_appsync_wssEndpoint:"wss://pir.{REGION}.sportsbook.fanduel.ca/graphql/realtime",aws_appsync_region:"ca-west-1",aws_appsync_authenticationType:"PIR_AUTH_KEY",aws_appsync_clientId:"test-ca-client"';
  const bundle = `const us={${us}},ca={${ca}};`;
  assert.deepEqual(parseFanDuelPushConfig(bundle), config("test-ca-client"));
  assert.deepEqual(parseFanDuelPushConfig(bundle, "nj"), config("test-us-client", "nj"));
  assert.throws(() => parseFanDuelPushConfig(`const us={${us}};`), /was not found/, "Ontario must not silently use the US config");
  assert.throws(() => parseFanDuelPushConfig(`const ca={${ca}};`, "nj"), /was not found/);
  assert.throws(() => parseFanDuelPushConfig(bundle.replaceAll("PIR_AUTH_KEY", "OTHER")), /configuration has changed/);
  assert.throws(() => parseFanDuelPushConfig(bundle, "../../bad"), /region/);
  assert.throws(() => parseFanDuelPushConfig(bundle, "ab"), /Unsupported/);
  const urls = [];
  const discovered = await discoverFanDuelPushConfig({ fetchImpl: async url => {
    urls.push(url);
    return new Response(url.endsWith("sw.js") ? '<script src="/static/js/main.example.js"></script>' : bundle);
  } });
  assert.equal(discovered.clientId, "test-ca-client");
  assert.deepEqual(urls, ["https://sportsbook.fanduel.ca/sw.js", "https://sportsbook.fanduel.ca/static/js/main.example.js"]);
  await assert.rejects(discoverFanDuelPushConfig({ fetchImpl: async () => new Response("denied", { status: 403 }) }), /HTTP 403/);
});

test("FanDuel sends the selected regional Origin and refuses cross-region injected configuration", async t => {
  for (const region of ["on", "nj"]) {
    const h = await harness(t, { options: { region, fetchConfig: async () => config("test-client", region) } });
    h.transport.setMarketIds(["734.1"]); h.transport.start();
    await until(() => h.transport.state.status === "subscribed");
    const request = h.messages[0].request;
    const auth = JSON.parse(Buffer.from(new URL(request.url, "http://local").searchParams.get("header"), "base64").toString());
    assert.equal(request.headers.origin, region === "on" ? "https://sportsbook.fanduel.ca" : "https://sportsbook.fanduel.com");
    assert.equal(auth.host, new URL(config("test-client", region).endpoint).host);
    assert.equal(h.transport.state.region, region);
    h.transport.stop();
  }
  const wrong = await harness(t, { options: { fetchConfig: async () => config("wrong-us-key", "nj") } });
  wrong.transport.setMarketIds(["734.1"]); wrong.transport.start();
  await until(() => wrong.states.some(s => /does not match the requested region/.test(s.error ?? "")));
  assert.equal(wrong.sockets.length, 0);
});

test("FanDuel push delivers acknowledged requested market data, not heartbeats or malformed frames", async t => {
  const h = await harness(t); h.transport.setMarketIds(["734.1"]); h.transport.start();
  await until(() => h.states.some(s => s.status === "subscribed"));
  const { socket, msg } = h.messages.find(x => x.msg.type === "start");
  const payload = JSON.parse(msg.payload.data);
  assert.deepEqual(payload.variables.ids, ["734.1"]);
  assert.match(payload.query, /onUpdateMarketPrice/);
  socket.send("not-json");
  send(socket, { type: "unknown" });
  send(socket, { type: "ka" });
  send(socket, { type: "data", id: "old-generation", payload: { data: { onUpdateMarketPrice: market() } } });
  send(socket, { type: "data", id: msg.id, payload: { data: { onUpdateMarketPrice: market("734.2") } } });
  send(socket, { type: "data", id: msg.id, payload: { data: { onUpdateMarketPrice: market() } } });
  await until(() => h.updates.length === 1);
  assert.deepEqual(h.updates[0].data, [market()]);
  assert.equal(h.updates[0].timing.sourceUpdatedAt, Date.parse(market().updatedAt));
  assert.equal(h.updates[0].timing.generation, 1);
  assert.equal(h.transport.counters.invalidFrames, 4);
  assert.equal(h.transport.state.lastDataAt, h.updates[0].timing.receivedAt);
});

test("FanDuel invalid market data on an active subscription degrades the channel and reconnects", async t => {
  const h = await harness(t); h.transport.setMarketIds(["734.1"]); h.transport.start();
  await until(() => h.transport.state.status === "subscribed");
  const { socket, msg } = h.messages.find(x => x.msg.type === "start");
  send(socket, { type: "data", id: msg.id, payload: { data: { onUpdateMarketPrice: { ...market(), runnerDetails: "bad" } } } });
  await until(() => h.states.some(s => s.status === "error" && /malformed market data/.test(s.error)));
  assert.equal(h.updates.length, 0);
  assert.equal(h.transport.counters.invalidFrames, 1);
  await until(() => h.transport.state.status === "subscribed" && h.transport.generation === 2);
});

test("FanDuel waits for every chunk acknowledgement and replaces subscriptions without an empty gap", async t => {
  const h = await harness(t, { options: { batchSize: 1, ackTimeoutMs: 500 }, handler: (socket, msg) => {
    if (msg.type === "connection_init") send(socket, { type: "connection_ack" });
  } });
  h.transport.setMarketIds(["734.1", "734.2"]); h.transport.start();
  await until(() => h.messages.filter(x => x.msg.type === "start").length === 2);
  const starts = h.messages.filter(x => x.msg.type === "start");
  send(starts[0].socket, { type: "start_ack", id: starts[0].msg.id });
  await pause(10); assert.equal(h.states.some(s => s.status === "subscribed"), false);
  send(starts[1].socket, { type: "start_ack", id: starts[1].msg.id });
  await until(() => h.transport.state.status === "subscribed");
  assert.equal(h.transport.state.subscribedMarkets, 2);
  h.transport.setMarketIds(["734.3"]);
  await until(() => h.messages.filter(x => x.msg.type === "start").length === 3);
  assert.equal(h.messages.some(x => x.msg.type === "stop"), false);
  const replacement = h.messages.filter(x => x.msg.type === "start").at(-1);
  send(replacement.socket, { type: "start_ack", id: replacement.msg.id });
  await until(() => h.messages.filter(x => x.msg.type === "stop").length === 2);
  assert.equal(h.transport.state.subscribedMarkets, 1);
});

test("FanDuel times out missing connection and subscription acknowledgements and reconnects", async t => {
  for (const connectionAck of [false, true]) {
    const h = await harness(t, { options: { ackTimeoutMs: 25 }, handler: (socket, msg) => {
      if (connectionAck && msg.type === "connection_init") send(socket, { type: "connection_ack" });
    } });
    h.transport.setMarketIds(["734.1"]); h.transport.start();
    await until(() => h.sockets.length >= 2);
    assert(h.states.some(s => s.status === "error" && /acknowledgement timed out/.test(s.error)));
    assert.equal(h.transport.counters.configReads, 1, "ordinary reconnect reuses public configuration");
    h.transport.stop();
  }
});

test("FanDuel reconnects a closed subscription with a new generation and cached public config", async t => {
  const h = await harness(t); h.transport.setMarketIds(["734.1"]); h.transport.start();
  await until(() => h.transport.state.status === "subscribed");
  h.sockets[0].close(1001);
  await until(() => h.transport.state.status === "subscribed" && h.transport.generation === 2);
  assert.equal(h.transport.counters.configReads, 1);
  assert.equal(h.transport.counters.reconnects, 1);
  const second = h.messages.filter(x => x.msg.type === "start").at(-1);
  send(second.socket, { type: "data", id: second.msg.id, payload: { data: { onUpdateMarketPrice: market() } } });
  await until(() => h.updates.length === 1);
  assert.equal(h.updates[0].timing.generation, 2);
});

test("FanDuel refreshes a rejected public key once and backs off repeated rejection", async t => {
  let reads = 0;
  const h = await harness(t, { options: { fetchConfig: async () => config(`key-${++reads}`), keyRefreshMs: 500 }, handler: (socket, msg) => {
    if (msg.type === "connection_init") send(socket, { type: "connection_error", payload: { errors: [{ errorType: "UnauthorizedException" }] } });
  } });
  h.transport.setMarketIds(["734.1"]); h.transport.start();
  await until(() => h.transport.counters.authErrors >= 2);
  assert.equal(reads, 2);
  const keys = h.messages.map(x => JSON.parse(Buffer.from(new URL(x.request.url, "http://local").searchParams.get("header"), "base64").toString()).Authorization);
  assert.deepEqual(keys.slice(0, 2), ["key-1", "key-2"]);
  await pause(60);
  assert.equal(reads, 2, "auth errors do not repeatedly download the bundle");
  assert(!JSON.stringify(h.states).includes("key-1"), "state diagnostics never disclose the public auth value");
});

test("FanDuel detects silent sockets and stop cancels reconnects", async t => {
  const h = await harness(t, { serverOptions: { autoPong: false }, options: { heartbeatMs: 40, pingMs: 10 } });
  h.transport.setMarketIds(["734.1"]); h.transport.start();
  await until(() => h.states.some(s => /heartbeat timed out/.test(s.error ?? "")));
  h.transport.stop(); const count = h.sockets.length;
  await pause(80);
  assert.equal(h.sockets.length, count);
  assert.equal(h.transport.state.status, "disconnected");
  assert.equal(h.transport.socketTimers.size, 0);
});

test("FanDuel pongs cannot hide missing AppSync keepalives, and server deadlines are bounded", async t => {
  const h = await harness(t, { options: { heartbeatMs: 200, pingMs: 10, maxProtocolHeartbeatMs: 50 }, handler: (socket, msg) => {
    if (msg.type === "connection_init") send(socket, { type: "connection_ack", payload: { connectionTimeoutMs: 999999999 } });
    if (msg.type === "start") send(socket, { type: "start_ack", id: msg.id });
  } });
  h.transport.setMarketIds(["734.1"]); h.transport.start();
  await until(() => h.transport.state.status === "subscribed");
  assert.equal(h.transport.state.protocolTimeoutMs, 50);
  await until(() => h.states.some(s => /protocol heartbeat timed out/.test(s.error ?? "")));
  const failed = h.states.find(s => /protocol heartbeat timed out/.test(s.error ?? ""));
  assert(failed.lastConfirmedAt > failed.lastProtocolAt, "pongs continued after the last AppSync message");
  h.transport.stop();
});

test("FanDuel stop aborts configuration discovery and prevents a late socket", async t => {
  let release, aborted = false;
  const h = await harness(t, { options: { fetchConfig: ({ signal }) => new Promise(resolve => {
    release = resolve; signal.addEventListener("abort", () => { aborted = true; });
  }) } });
  h.transport.setMarketIds(["734.1"]); h.transport.start();
  await until(() => release);
  h.transport.stop(); release(config("late-key")); await pause(20);
  assert.equal(aborted, true); assert.equal(h.sockets.length, 0);
});
