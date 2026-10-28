"""Bounded comparison of ordinary HTTP and browser-compatible TLS/HTTP transports.

Reads only the app's public endpoint configuration on stdin. No personal cookies,
login tokens, proxies, CAPTCHA service, or disabled certificate verification.
Install the optional curl_cffi dependency separately from the production app.
"""
import json
import sys
import time
from curl_cffi import Session

config = json.load(sys.stdin)
with Session(impersonate="chrome") as session:
    for label, url in [
        ("configured-ontario-snapshot", config["snapshot"]),
        ("public-content-league", "https://sportsbook-nash.draftkings.com/api/sportscontent/dkcaon/v1/leagues/88808/categories/492/subcategories/4518"),
    ]:
        started = time.monotonic()
        try:
            response = session.get(url, headers=config["headers"], timeout=12)
            result = {
                "label": label, "status": response.status_code,
                "server": response.headers.get("server"),
                "bytes": len(response.content),
                "elapsedMs": round((time.monotonic() - started) * 1000, 2),
            }
            if response.status_code == 200:
                data = response.json()
                result.update({key: len(data.get(key, [])) for key in ("events", "markets", "selections")})
            print(json.dumps(result), flush=True)
        except Exception as error:
            print(json.dumps({"label": label, "error": str(error)}), flush=True)
    try:
        with session.ws_connect(config["socket"], headers={"Origin": "https://sportsbook.draftkings.com"}, timeout=12) as ws:
            ws.send_json(config["subscription"], timeout=5)
            message = ws.recv_json(timeout=10)
            print(json.dumps({"label": "websocket", "event": message.get("event"), "error": message.get("error")}), flush=True)
    except Exception as error:
        print(json.dumps({"label": "websocket", "error": str(error)}), flush=True)
