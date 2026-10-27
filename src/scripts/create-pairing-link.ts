import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthService } from "../server/auth.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/database.js";
import { PairingService } from "../server/pairing.js";

const config = loadConfig();
const database = new AppDatabase(config);
try {
  const auth = new AuthService(database, config.sessionDays);
  const result = new PairingService(database, auth, config.publicBaseUrl).createLink();
  const path = join(config.dataDir, "pairing-link");
  writeFileSync(path, result.uri, { mode: 0o600 });
  chmodSync(path, 0o600);
  process.stdout.write(`One-time pairing link written to ${path} (expires ${result.expiresAt}).\n`);
} finally {
  database.close();
}
