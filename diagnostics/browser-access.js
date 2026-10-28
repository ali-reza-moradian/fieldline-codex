// Optional server-side integration diagnostic, separate from the running collectors.
// One fresh, logged-out browser visit. No personal profile, copied cookies, stealth
// modifications, CAPTCHA solving, certificate bypass, or cross-origin bypass.
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { mkdirSync, writeFileSync } from "node:fs";

const observations = [];
const report = (data) => {
  const item = { diagnostic: "browser-access", at: new Date().toISOString(), ...data };
  observations.push(item);
  console.log(JSON.stringify(item));
  mkdirSync("data", { recursive: true });
  writeFileSync("data/cloud-access-check.json", JSON.stringify(observations));
};
let browser;
let timer;
const hardStop = setTimeout(() => {
  report({ result: "hard-timeout" });
  process.exit(0);
}, 120000);
try {
  report({ phase: "launching", at: new Date().toISOString() });
  browser = await playwright.launch({
    executablePath: await chromium.executablePath(),
    // Keep ordinary web-security and TLS checks enabled. The process is disposable
    // inside the hosting container; do not use the package's insecure web flags.
    args: ["--disable-dev-shm-usage", "--disable-gpu"],
    timeout: 30000,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const statuses = [];
  let finish;
  const acquired = new Promise((resolve) => { finish = resolve; });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.hostname !== "sportsbook-nash.draftkings.com" ||
        !url.pathname.includes("/api/sportscontent/controldata/") ||
        !url.pathname.endsWith("/markets")) return;
    const item = { phase: "snapshot-response", status: response.status(), path: url.pathname };
    statuses.push(item);
    if (response.ok()) {
      try {
        const data = await response.json();
        item.events = data.events?.length;
        item.markets = data.markets?.length;
        item.selections = data.selections?.length;
        report(item);
        if (item.events && item.selections) finish({ result: "snapshot-observed", ...item });
      } catch { report({ ...item, error: "Response was not snapshot JSON" }); }
    } else report(item);
  });
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ result: "no-successful-snapshot", statuses }), 90000);
  });
  await page.goto("https://sportsbook.draftkings.com/leagues/football/nfl", {
    waitUntil: "domcontentloaded", timeout: 60000,
  });
  report({ phase: "page-loaded", title: await page.title() });
  report(await Promise.race([acquired, timeout]));
} catch (error) {
  report({ result: "error", message: error.message.slice(0, 1500) });
} finally {
  clearTimeout(timer);
  if (browser) await browser.close().catch(() => {});
  clearTimeout(hardStop);
}
