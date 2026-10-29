import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UpstreamError, parseRetryAfter } from "./http.js";

const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
const script = fileURLToPath(new URL("./curl-batch.py", import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;

export async function fetchCurlJsonBatch(requests, { headers = {}, signal } = {}) {
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
  signal?.throwIfAborted();
  const began = Date.now();
  const envelope = await new Promise((resolve, reject) => {
    const child = execFile(python, [script], {
      timeout: 30000, maxBuffer: 24 * 1024 * 1024, killSignal: "SIGKILL", signal,
    }, (error, stdout) => {
      if (error?.name === "AbortError") return reject(error);
      let result;
      try { result = JSON.parse(stdout); } catch { /* No partial output is usable. */ }
      if (error || result?.error) return reject(new UpstreamError(result?.error ||
        `Batch snapshot transport failed: ${error?.code || "invalid response"}. Run INSTALL_CURL_TRANSPORT=1 npm ci to install it.`));
      if (!Array.isArray(result?.results)) return reject(new UpstreamError("Batch snapshot returned invalid metadata"));
      resolve(result);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ requests, headers }));
  });
  signal?.throwIfAborted();
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
    if (typeof result.body !== "string" || !Number.isFinite(result.durationMs) || result.durationMs < 0)
      throw new UpstreamError("Batch snapshot returned invalid response metadata");
    const decodedBytes = Buffer.byteLength(result.body);
    bytes += decodedBytes;
    if (decodedBytes !== result.decodedBytes || bytes > MAX_BYTES)
      throw new UpstreamError("Source batch response exceeds its body limit or reports an invalid size");
    let data;
    try { data = JSON.parse(result.body); } catch { throw new UpstreamError("Source returned invalid JSON"); }
    responses.push({ id: result.id, data, receivedAt: result.receivedAt, durationMs: result.durationMs,
      decodedBytes, wireBytes: Number(result.contentLength) || null });
  }
  if (responses.length !== requests.length) throw new UpstreamError("Batch snapshot omitted a requested category");
  return responses;
}
