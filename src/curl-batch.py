"""Bounded sequential public GETs in one TLS-verified curl session.

Used by optional markets only. A response is published by Node only after every
requested category has returned successfully and passed independent validation.
"""
import json
import sys
import time
from urllib.parse import urlsplit

from curl_cffi import Session

MAX_REQUESTS = 7
MAX_BODY = 8 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024
NETWORK_BUDGET_SECONDS = 25


def run():
    request = json.load(sys.stdin)
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
    # Explicit verification and disabled environment proxies match the main
    # collector. Reusing the session avoids seven imports/TLS handshakes.
    with Session(impersonate="chrome", trust_env=False, verify=True) as session:
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

            # curl_cffi's stream() duplicates/closes the easy handle for every
            # request. A bounded content callback retains the session's handle
            # and connection cache without allowing an unbounded response body.
            response = session.get(job["url"], headers=headers,
                                   timeout=min(10, remaining), allow_redirects=False,
                                   content_callback=receive)
            result = {
                "id": job["id"],
                "url": job["url"],
                "status": response.status_code,
                "retryAfter": response.headers.get("retry-after"),
                "contentLength": response.headers.get("content-length"),
                "receivedAt": time.time_ns() // 1_000_000,
            }
            if not 200 <= response.status_code < 300:
                results.append(result)
                # In particular, never continue after HTTP 429.
                return {"results": results}
            body = b"".join(chunks).decode("utf-8")
            # Fail before requesting later categories when a source sends
            # an HTML/error body with a successful HTTP status.
            try:
                json.loads(body)
            except (ValueError, TypeError) as error:
                raise ValueError("Source returned invalid JSON") from error
            result.update({
                "body": body,
                "durationMs": (time.monotonic() - started) * 1000,
                "decodedBytes": size,
            })
            results.append(result)
    return {"results": results}


if __name__ == "__main__":
    try:
        print(json.dumps(run(), ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
