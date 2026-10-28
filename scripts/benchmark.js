import { mkdir, writeFile } from "node:fs/promises";
import { distribution } from "../src/metrics.js";

const base = process.argv[2] || "http://localhost:3210";
const seconds = Math.max(10, Math.min(3600, Number(process.argv[3] || 60)));
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
      samples.push({
        book: data.timing.book,
        backendToClientMs: Date.now() - data.timing.receivedAt,
        sourceCreatedToClientMs: data.timing.sourceCreatedAt
          ? Date.now() - data.timing.sourceCreatedAt
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
  caution:
    "CLI client timings require synchronized server/client clocks; they are not browser render or full bookmaker-change latency.",
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
