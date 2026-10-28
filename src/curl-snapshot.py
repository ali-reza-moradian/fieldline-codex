"""One bounded public HTTP snapshot. Stream updates remain in the Node collector."""
import json
import sys
from curl_cffi import Session

MAX_BODY = 8 * 1024 * 1024
try:
    request = json.load(sys.stdin)
    with Session(impersonate="chrome", trust_env=False) as session:
        with session.stream("GET", request["url"], headers=request.get("headers", {}), timeout=10) as response:
            result = {
                "status": response.status_code,
                "retryAfter": response.headers.get("retry-after"),
                "contentLength": response.headers.get("content-length"),
            }
            if 200 <= response.status_code < 300:
                chunks, size = [], 0
                for chunk in response.iter_content():
                    size += len(chunk)
                    if size > MAX_BODY:
                        raise ValueError("Source response exceeds 8 MiB limit")
                    chunks.append(chunk)
                result["body"] = b"".join(chunks).decode("utf-8")
            print(json.dumps(result), flush=True)
except Exception as error:
    print(json.dumps({"error": str(error)}), flush=True)
    sys.exit(1)
