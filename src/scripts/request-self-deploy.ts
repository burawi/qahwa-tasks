import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../server/config.js";

const humanId = process.argv[2]?.trim().toUpperCase();
if (!humanId || !/^[A-Z][A-Z0-9_-]*-\d+$/.test(humanId)) {
  throw new Error("Usage: npm run deploy:self -- QAH-0001");
}

const { dataDir } = loadConfig();
writeFileSync(join(dataDir, "self-deploy-request.json"), JSON.stringify({ humanId, requestedAt: new Date().toISOString() }), {
  encoding: "utf8",
  mode: 0o600,
});
console.log("Build is ready. Qahwa Tasks will restart after this Codex turn completes.");
