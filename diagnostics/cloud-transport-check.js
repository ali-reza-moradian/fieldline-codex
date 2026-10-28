// Temporary diagnostic entry point; keeps the normal app available during checks.
import { createApp } from "../src/server.js";
import { Metrics } from "../src/metrics.js";
import { DK_HEADERS, DK_SNAPSHOT, DK_SOCKET, subscription } from "../src/adapters/draftkings.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const report = { startedAt: new Date().toISOString(), phase: "starting", results: [] };
const metrics = new Metrics();
const originalReport = metrics.report.bind(metrics);
metrics.report = (...args) => ({ ...originalReport(...args), accessDiagnostic: report });
const app = createApp({ metrics });
app.server.listen(Number(process.env.PORT || 3210), process.env.HOST || "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => { await app.shutdown(); process.exit(0); });

function run(command, args, { input, env = process.env, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (chunk) => { if (output.length < 20000) output += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ error: error.message }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, stderr }); });
    child.stdin.end(input);
  });
}

async function check() {
  report.phase = "native-http";
  for (const [label, url] of [
    ["node-ontario-snapshot", DK_SNAPSHOT],
    ["node-public-content-league", "https://sportsbook-nash.draftkings.com/api/sportscontent/dkcaon/v1/leagues/88808/categories/492/subcategories/4518"],
  ]) {
    try {
      const response = await fetch(url, { headers: DK_HEADERS, signal: AbortSignal.timeout(10000) });
      const text = await response.text();
      const item = { label, status: response.status, bytes: Buffer.byteLength(text), server: response.headers.get("server") };
      if (response.ok) {
        const data = JSON.parse(text);
        for (const key of ["events", "markets", "selections"]) item[key] = data[key]?.length;
      }
      report.results.push(item);
    } catch (error) { report.results.push({ label, error: error.message }); }
  }
  report.phase = "installing-optional-client";
  const dir = await mkdtemp(join(tmpdir(), "fieldline-transport-"));
  const install = await run("python3", ["-m", "pip", "install", "--target", dir, "-r", "diagnostics/requirements-transport.txt"]);
  if (install.code !== 0) {
    // Metadata only: do not publish process environment or package-manager output.
    report.results.push({ label: "optional-client-install", code: install.code, signal: install.signal, error: install.error });
    return;
  }
  report.phase = "browser-compatible-transport";
  const result = await run("python3", ["-c", await readFile("diagnostics/transport-access.py", "utf8")], {
    input: JSON.stringify({ snapshot: DK_SNAPSHOT, headers: DK_HEADERS, socket: DK_SOCKET, subscription: subscription("cloud-transport-check") }),
    env: { ...process.env, PYTHONPATH: dir },
  });
  for (const line of (result.output || "").trim().split("\n")) {
    try { report.results.push(JSON.parse(line)); } catch { /* Only structured metadata is published. */ }
  }
  if (result.code !== 0) report.results.push({ label: "optional-client", code: result.code, signal: result.signal, error: result.error });
}
if (process.env.RENDER === "true")
  check().catch((error) => { report.error = error.message; }).finally(() => {
    report.phase = "finished";
    report.finishedAt = new Date().toISOString();
  });
else report.phase = "not-run-outside-render";
