import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { UpstreamError, parseRetryAfter } from "./http.js";

const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
const script = fileURLToPath(new URL("./curl-batch.py", import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;

function validateRequests(requests) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 7)
    throw new TypeError("Batch must contain 1–7 requests");
  const ids = new Set();
  for (const request of requests) {
    if (!request || typeof request.id !== "string" || !request.id || ids.has(request.id))
      throw new TypeError("Batch request identities must be unique strings");
    ids.add(request.id);
    const url = new URL(request.url);
    if (url.username || url.password || !(url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
      throw new TypeError("Batch requires HTTPS; plain HTTP is limited to loopback tests");
  }
}

function decodeResponses(envelope, requests, began) {
  if (envelope?.error) throw new UpstreamError(String(envelope.error));
  if (!Array.isArray(envelope?.results)) throw new UpstreamError("Batch snapshot returned invalid metadata");
  let bytes = 0, previousAt = began;
  const responses = [];
  for (let i = 0; i < envelope.results.length; i++) {
    const result = envelope.results[i], requested = requests[i];
    if (!requested || result?.id !== requested.id || result.url !== requested.url || !Number.isInteger(result.status) ||
        !Number.isFinite(result.receivedAt) || result.receivedAt < previousAt || result.receivedAt > Date.now() + 1000)
      throw new UpstreamError("Batch snapshot returned invalid category identity or timestamp");
    previousAt = result.receivedAt;
    if (result.status < 200 || result.status >= 300)
      throw new UpstreamError(`HTTP ${result.status} from ${new URL(requested.url).hostname}`,
        result.status, parseRetryAfter(result.retryAfter));
    if (!Object.hasOwn(result, "data") || !Number.isFinite(result.durationMs) || result.durationMs < 0 ||
        !Number.isSafeInteger(result.decodedBytes) || result.decodedBytes < 0)
      throw new UpstreamError("Batch snapshot returned invalid response metadata");
    bytes += result.decodedBytes;
    if (bytes > MAX_BYTES) throw new UpstreamError("Source batch response exceeds its body limit");
    responses.push({ id: result.id, data: result.data, receivedAt: result.receivedAt, durationMs: result.durationMs,
      decodedBytes: result.decodedBytes, wireBytes: Number(result.contentLength) || null });
  }
  if (responses.length !== requests.length) throw new UpstreamError("Batch snapshot omitted a requested category");
  return responses;
}

/** One bounded, single-flight JSONL connection to an extras-only Python process.
 * An abort retires the entire process generation. Late bytes/exit callbacks can
 * never resolve a request sent to its replacement. Idle processes are reclaimed.
 */
export class CurlJsonBatchClient {
  constructor({ idleTimeoutMs = 60000, batchTimeoutMs = 30000 } = {}) {
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 60000 ||
        !Number.isFinite(batchTimeoutMs) || batchTimeoutMs <= 0 || batchTimeoutMs > 30000)
      throw new RangeError("Batch and idle deadlines must be positive and within their production bounds");
    this.idleTimeoutMs = idleTimeoutMs; this.batchTimeoutMs = batchTimeoutMs;
    this.child = null; this.pending = null; this.closed = false; this.generation = 0; this.nextId = 0; this.idleTimer = null;
  }
  get pid() { return this.child?.pid ?? null; }
  start() {
    if (this.child) return this.child;
    const child = spawn(python, [script, "--worker"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; const generation = ++this.generation;
    const decoder = new StringDecoder("utf8"); let buffer = "", bytes = 0, stderr = "";
    const current = () => this.child === child && this.generation === generation;
    child.stdout.on("data", chunk => {
      if (!current()) return;
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) return this.retire(new UpstreamError("Batch worker response exceeds protocol limit"));
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); bytes = Buffer.byteLength(buffer);
        if (!line.trim()) continue;
        let envelope;
        try { envelope = JSON.parse(line); }
        catch { return this.retire(new UpstreamError("Batch worker returned invalid JSON protocol")); }
        const job = this.pending;
        if (!job || job.generation !== generation || envelope.requestId !== job.id)
          return this.retire(new UpstreamError("Batch worker returned an unexpected request identity"));
        try { this.finish(null, decodeResponses(envelope, job.requests, job.began)); }
        catch (error) { this.finish(error); }
        if (!current()) return;
      }
    });
    child.stderr.on("data", chunk => { if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192-stderr.length); });
    child.on("error", error => { if (current()) this.retire(new UpstreamError(`Batch worker could not start: ${error.code ?? error.message}`)); });
    child.on("exit", (code, signal) => {
      if (current()) this.retire(new UpstreamError(`Batch worker exited (${signal ?? code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    child.stdin.on("error", error => { if (current()) this.retire(new UpstreamError(`Batch worker input failed: ${error.code ?? error.message}`)); });
    return child;
  }
  async fetch(requests, { headers = {}, signal } = {}) {
    validateRequests(requests);
    if (this.closed) throw new UpstreamError("Batch client is closed");
    if (this.pending) throw new UpstreamError("Batch client already has an active request");
    signal?.throwIfAborted();
    const id = ++this.nextId, input = JSON.stringify({ requestId: id, requests, headers }) + "\n";
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new RangeError("Batch input exceeds protocol limit");
    clearTimeout(this.idleTimer); this.idleTimer = null;
    return new Promise((resolve, reject) => {
      const job = { id, requests, began: Date.now(), resolve, reject, signal, timer: null, abort: null, generation: null };
      this.pending = job;
      try {
        const child = this.start(); job.generation = this.generation;
        job.abort = () => { if (this.pending === job) this.retire(signal.reason ?? new DOMException("Batch canceled", "AbortError")); };
        signal?.addEventListener("abort", job.abort, { once: true });
        job.timer = setTimeout(() => { if (this.pending === job) this.retire(new UpstreamError("Batch request deadline exceeded")); }, this.batchTimeoutMs);
        if (signal?.aborted) { job.abort(); return; }
        child.stdin.write(input, error => { if (error && this.pending === job) this.retire(new UpstreamError(`Batch worker input failed: ${error.message}`)); });
      } catch (error) { this.retire(error); }
    });
  }
  finish(error, responses) {
    const job = this.pending; if (!job) return;
    this.pending = null; clearTimeout(job.timer); job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error); else job.resolve(responses);
    if (this.child && !this.closed) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.pending) this.retire(); }, this.idleTimeoutMs);
      this.idleTimer.unref?.();
    }
  }
  retire(error) {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    const child = this.child; this.child = null; this.generation++;
    if (child) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill("SIGKILL"); }
    if (this.pending) this.finish(error ?? new DOMException("Batch process closed", "AbortError"));
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.retire(new DOMException("Batch client closed", "AbortError"));
  }
}

// Compatibility helper for diagnostics and isolated calls. Production extras
// workers own one client and close it with their lifecycle instead.
export async function fetchCurlJsonBatch(requests, options = {}) {
  const client = new CurlJsonBatchClient();
  try { return await client.fetch(requests, options); }
  finally { client.close(); }
}
