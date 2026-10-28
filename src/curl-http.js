import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UpstreamError, parseRetryAfter } from "./http.js";

const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
const script = fileURLToPath(new URL("./curl-snapshot.py", import.meta.url));

export async function fetchCurlJson(url, { headers = {}, signal } = {}) {
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = execFile(python, [script], {
      timeout: 12000,
      maxBuffer: 16 * 1024 * 1024,
      killSignal: "SIGKILL",
      signal,
    }, (error, stdout) => {
      if (error?.name === "AbortError") return reject(error);
      let result;
      try { result = JSON.parse(stdout); } catch { /* Missing/malformed worker response fails closed. */ }
      if (error || result?.error)
        return reject(new UpstreamError(result?.error || `Snapshot transport failed: ${error?.code || "invalid response"}. Run INSTALL_CURL_TRANSPORT=1 npm ci to install it.`));
      if (!Number.isInteger(result?.status))
        return reject(new UpstreamError("Snapshot transport returned invalid metadata"));
      resolve(result);
    });
    child.stdin.on("error", () => {}); // execFile reports spawn/termination errors.
    child.stdin.end(JSON.stringify({ url, headers }));
  });
  if (result.status < 200 || result.status >= 300)
    throw new UpstreamError(`HTTP ${result.status} from ${new URL(url).hostname}`, result.status, parseRetryAfter(result.retryAfter));
  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new UpstreamError("Source returned invalid JSON"); }
  return {
    data,
    receivedAt: Date.now(),
    durationMs: performance.now() - start,
    decodedBytes: Buffer.byteLength(result.body),
    wireBytes: Number(result.contentLength) || null,
  };
}
