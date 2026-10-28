export class UpstreamError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
export function parseRetryAfter(retry) {
  if (!retry) return 0;
  const delay = Number.isFinite(Number(retry))
    ? Number(retry) * 1000
    : Date.parse(retry) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}
export async function fetchJson(url, options = {}) {
  const start = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10000),
  });
  const retry = response.headers.get("retry-after");
  const retryAfterMs = parseRetryAfter(retry);
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError(
      `HTTP ${response.status} from ${new URL(url).hostname}`,
      response.status,
      retryAfterMs,
    );
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UpstreamError("Source returned invalid JSON");
  }
  return {
    data,
    receivedAt: Date.now(),
    durationMs: performance.now() - start,
    decodedBytes: Buffer.byteLength(text),
    wireBytes: Number(response.headers.get("content-length")) || null,
  };
}
export function retryDelay(failures, error, base = 1000) {
  const backoff = Math.min(60000, base * 2 ** Math.min(failures - 1, 6));
  return Math.max(
    error?.retryAfterMs || 0,
    backoff + Math.random() * backoff * 0.2,
  );
}
