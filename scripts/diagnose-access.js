// Read-only, bounded checks of the public page and the snapshot it advertises.
// Print only response metadata and public feed configuration, never cookies or page HTML.
import { DK_HEADERS, DK_SNAPSHOT } from "../src/adapters/draftkings.js";

async function inspect(label, url, headers = {}) {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    const result = {
      label,
      status: response.status,
      host: new URL(response.url).hostname,
      contentType: response.headers.get("content-type"),
      server: response.headers.get("server"),
      bytes: Buffer.byteLength(body),
    };
    console.log(JSON.stringify(result));
    return { response, body };
  } catch (error) {
    console.log(JSON.stringify({ label, error: error.message }));
    return null;
  }
}

await inspect("configured-ontario-snapshot", DK_SNAPSHOT, DK_HEADERS);
const page = await inspect(
  "public-nfl-page",
  "https://sportsbook.draftkings.com/leagues/football/nfl",
);
if (page?.response.ok) {
  const assignment = page.body.match(/window\.__productConfig\s*=\s*(\{[^\n]+\})\s*;/);
  if (assignment) {
    try {
      const config = JSON.parse(assignment[1]);
      const publicConfig = Object.fromEntries(
        ["displayName", "siteName", "geoCodeEmbeddedResourceId", "controlDataBff", "sportsDataBaseWebSocketUrl"]
          .map((key) => [key, config[key]]),
      );
      console.log(JSON.stringify({ label: "page-selected-region", ...publicConfig }));
      if (typeof config.controlDataBff === "string") {
        const url = new URL("league/leagueSubcategory/v1/markets", config.controlDataBff);
        url.search = new URL(DK_SNAPSHOT).search;
        // Follow only an HTTPS feed on the same known public API host.
        if (url.protocol === "https:" && url.hostname === "sportsbook-nash.draftkings.com" && url.href !== DK_SNAPSHOT) {
          await inspect("page-selected-snapshot", url, {
            ...DK_HEADERS,
            "x-pe-loc": config.geoCodeEmbeddedResourceId,
          });
        }
      }
    } catch (error) {
      console.log(JSON.stringify({ label: "public-config", error: error.message }));
    }
  } else console.log(JSON.stringify({ label: "public-config", error: "Page configuration not found" }));
}
