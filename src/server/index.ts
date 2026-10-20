import { buildApp } from "./app.js";
import { scheduleBackups } from "./backup.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./database.js";

const config = loadConfig();
const database = new AppDatabase(config);
const app = await buildApp(config, database);
const backupTimer = scheduleBackups(database, config.backupDir);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  clearInterval(backupTimer);
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
