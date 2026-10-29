import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server.js";

test("telemetry acceptance agrees with HTTP status and rejected samples are not stored", async () => {
  const app = createApp({ ingest: false });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${app.server.address().port}/api/telemetry`;
  const send = (sample) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sample),
  });
  try {
    const rejected = await send({ book: "unknown", phase: "pregame", backendToPaintMs: 20 });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { accepted: false });
    assert.equal(app.metrics.browser.length, 0);

    const accepted = await send({ book: "draftkings", phase: "pregame", backendToPaintMs: 20 });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true });
    assert.equal(app.metrics.browser.length, 1);
  } finally {
    await app.shutdown();
  }
});
