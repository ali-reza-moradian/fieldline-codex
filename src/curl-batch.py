"""Bounded public GET batches over one verified, reusable curl session.

Worker mode exchanges one JSON object per line. Each response contains every
category or one failure; Node only publishes complete validated batches.
"""
import json
import sys
import time
from urllib.parse import urlsplit

from curl_cffi import Session

MAX_REQUESTS = 7
MAX_BODY = 8 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024
MAX_INPUT = 64 * 1024
NETWORK_BUDGET_SECONDS = 25


def invalid_constant(value):
    raise ValueError("Non-finite JSON value: " + value)


def run(request, session):
    jobs = request.get("requests")
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= MAX_REQUESTS:
        raise ValueError("Batch must contain 1–7 requests")
    seen = set()
    for job in jobs:
        identity, url = job.get("id"), job.get("url")
        if not isinstance(identity, str) or not identity or identity in seen:
            raise ValueError("Batch request identities must be unique strings")
        seen.add(identity)
        parsed = urlsplit(url)
        if parsed.username or parsed.password or not (
            parsed.scheme == "https" or
            (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1"))
        ):
            raise ValueError("Batch requires HTTPS; plain HTTP is limited to loopback tests")
    headers = request.get("headers", {})
    results, total_size = [], 0
    deadline = time.monotonic() + NETWORK_BUDGET_SECONDS
    for job in jobs:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Batch network deadline exceeded")
        started = time.monotonic()
        chunks, size = [], 0

        def receive(chunk):
            nonlocal size, total_size
            size += len(chunk)
            total_size += len(chunk)
            if size > MAX_BODY or total_size > MAX_TOTAL:
                raise ValueError("Source batch response exceeds 8 MiB limit")
            if time.monotonic() > deadline:
                raise TimeoutError("Batch network deadline exceeded")
            chunks.append(chunk)
            return len(chunk)

        # stream() clones/closes the curl handle. A bounded content callback
        # preserves its connection cache across categories AND polling cycles.
        response = session.get(job["url"], headers=headers,
                               timeout=min(10, remaining), allow_redirects=False,
                               content_callback=receive)
        result = {
            "id": job["id"], "url": job["url"],
            "status": response.status_code,
            "retryAfter": response.headers.get("retry-after"),
            "contentLength": response.headers.get("content-length"),
            "receivedAt": time.time_ns() // 1_000_000,
        }
        if not 200 <= response.status_code < 300:
            results.append(result)
            return {"results": results}  # Never continue after HTTP 429.
        body = b"".join(chunks).decode("utf-8")
        try:
            data = json.loads(body, parse_constant=invalid_constant)
        except (ValueError, TypeError) as error:
            raise ValueError("Source returned invalid JSON") from error
        # Embed data directly: no escaping a JSON body inside another JSON string,
        # and Node needs only its one protocol parse rather than a second parse.
        result.update({"data": data, "durationMs": (time.monotonic() - started) * 1000,
                       "decodedBytes": size})
        results.append(result)
    return {"results": results}


def serve():
    last_id = 0
    # TLS verification is explicit; never inherit proxies or user browser state.
    with Session(impersonate="chrome", trust_env=False, verify=True) as session:
        while True:
            line = sys.stdin.buffer.readline(MAX_INPUT + 1)
            if not line:
                return
            if len(line) > MAX_INPUT or not line.endswith(b"\n"):
                raise ValueError("Invalid or oversized batch protocol input")
            request = json.loads(line, parse_constant=invalid_constant)
            request_id = request.get("requestId")
            if not isinstance(request_id, int) or isinstance(request_id, bool) or request_id <= last_id:
                raise ValueError("Batch request identity is not monotonic")
            last_id = request_id
            try:
                result = run(request, session)
                result["requestId"] = request_id
                output = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            except Exception as error:
                output = json.dumps({"requestId": request_id, "error": str(error)}, ensure_ascii=False)
            print(output, flush=True)
            del request, output
            # Do not retain the last market snapshot while waiting for new input.
            if "result" in locals():
                del result


if __name__ == "__main__":
    try:
        if "--worker" in sys.argv:
            serve()
        else:
            with Session(impersonate="chrome", trust_env=False, verify=True) as session:
                print(json.dumps(run(json.load(sys.stdin), session), ensure_ascii=False, allow_nan=False), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
