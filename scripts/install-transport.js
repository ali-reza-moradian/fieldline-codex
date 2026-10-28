import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Local native-Node runs need no Python. Render's public snapshot requires this
// transport; Docker and other hosts can opt in explicitly at build time.
if (process.env.RENDER === "true" || process.env.INSTALL_CURL_TRANSPORT === "1") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
  execFileSync(process.env.PYTHON || "python3", ["-m", "venv", ".venv"], { cwd: root, stdio: "inherit", timeout: 60000 });
  execFileSync(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements.txt"], { cwd: root, stdio: "inherit", timeout: 120000 });
}
