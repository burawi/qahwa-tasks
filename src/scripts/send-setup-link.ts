import { readFileSync } from "node:fs";
import { AuthService } from "../server/auth.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/database.js";

const config = loadConfig();
const database = new AppDatabase(config);
try {
  const auth = new AuthService(database, config.sessionDays, config.publicBaseUrl.startsWith("https://"));
  const setup = auth.createSetupToken();
  const response = await fetch(`${config.qahwaNotifyUrl}/v1/notifications`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readFileSync(config.qahwaNotifyTokenFile, "utf8").trim()}`,
      "content-type": "application/json",
      "idempotency-key": `qahwa-tasks:setup:${setup.expiresAt}`,
    },
    body: JSON.stringify({
      title: "Set up Qahwa Tasks",
      body: "Tap to choose your private password. This link expires in 15 minutes.",
      source: "qahwa-tasks",
      channel: "tasks",
      priority: "high",
      url: `${config.publicBaseUrl}/?setup=${encodeURIComponent(setup.token)}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Qahwa Notify returned HTTP ${response.status}`);
  console.log(`One-time setup link sent through Qahwa Notify; expires at ${setup.expiresAt}.`);
} finally {
  database.close();
}
