// Temporary deployment probe. Local startup does not install or launch a browser.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

if (process.env.RENDER && process.platform === "linux") {
  try {
    execFileSync("npm", ["ci", "--prefix", "diagnostics", "--ignore-scripts"], {
      stdio: "inherit", timeout: 90000,
    });
    execFileSync(process.execPath, ["--use-system-ca", "diagnostics/browser-access.js"], {
      stdio: "inherit", timeout: 130000,
    });
  } catch (error) {
    mkdirSync("data", { recursive: true });
    writeFileSync("data/cloud-access-check.json", JSON.stringify({
      diagnostic: "browser-access", result: "setup-error", message: error.message.slice(0, 1000),
    }));
  }
}
