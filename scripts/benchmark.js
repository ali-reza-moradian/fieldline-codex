import { mkdir, writeFile } from "node:fs/promises";
import { distribution } from "../src/metrics.js";

const base = process.argv[2] || "http://localhost:3210";
const seconds = Math.max(10, Math.min(3600, Number(process.argv[3] || 60)));
let clock;
for (let i = 0; i < 5; i++) {
  const wall = Date.now(), start = performance.now();
  const response = await fetch(base + "/api/time", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Clock calibration HTTP ${response.status}`);
  const { now } = await response.json(), rttMs = performance.now() - start;
  if (!Number.isFinite(now)) throw new Error("Invalid server clock response");
  if (!clock || rttMs < clock.rttMs)
    clock = { offsetMs: now - (wall + rttMs / 2), rttMs, uncertaintyMs: rttMs / 2, measuredAt: new Date().toISOString() };
}
const controller = new AbortController(),
  startedAt = new Date().toISOString();
const timer = setTimeout(() => controller.abort(), seconds * 1000),
  samples = [];
console.log(
  `Observing ${base} for ${seconds}s. This measures the HTTP client, not browser paint.`,
);
try {
  const response = await fetch(base + "/api/events", {
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.includes("event: delta")) continue;
      const data = JSON.parse(
        part
          .split("\n")
          .find((l) => l.startsWith("data: "))
          .slice(6),
      );
      if (!data.timing?.priceChanges) continue;
      samples.push({
        book: data.timing.book,
        backendToClientMs: Date.now() + clock.offsetMs - data.timing.receivedAt,
        sourceCreatedToClientMs: data.timing.sourceCreatedAt
          ? Date.now() + clock.offsetMs - data.timing.sourceCreatedAt
          : null,
        pushUpdatedToClientUpperBoundMs: data.timing.sourceUpdatedAt
          ? Date.now() + clock.offsetMs - data.timing.sourceUpdatedAt
          : null,
        bytes: Buffer.byteLength(part),
        kind: data.timing.kind,
        phase: data.timing.phases,
      });
    }
  }
} catch (error) {
  if (error.name !== "AbortError") throw error;
} finally {
  clearTimeout(timer);
}
const metrics = await (await fetch(base + "/api/metrics")).json();
const result = {
  startedAt,
  finishedAt: new Date().toISOString(),
  base,
  seconds,
  clockCalibration: clock,
  caution:
    "CLI times use the lowest-RTT of five server clock probes; half the RTT is a lower uncertainty bound. Provider-clock skew remains unknown. These are not browser render or full bookmaker-change latency measurements.",
  client: Object.fromEntries(
    ["draftkings", "fanduel"].map((book) => {
      const rows = samples.filter((s) => s.book === book);
      return [
        book,
        {
          backendToClientMs: distribution(rows.map((s) => s.backendToClientMs)),
          feedCreatedToClientMs: distribution(
            rows.map((s) => s.sourceCreatedToClientMs),
          ),
          pushUpdatedToClientUpperBoundMs: distribution(rows.map(s => s.pushUpdatedToClientUpperBoundMs)),
          ssePayloadBytes: distribution(rows.map((s) => s.bytes)),
        },
      ];
    }),
  ),
  metrics,
};
await mkdir("data", { recursive: true });
const file = `data/benchmark-${startedAt.replace(/[:.]/g, "-")}.json`;
await writeFile(file, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
console.log(`Saved ${file}`);
