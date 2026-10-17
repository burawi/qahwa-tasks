import { createBackup } from "../server/backup.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/database.js";

const config = loadConfig();
const database = new AppDatabase(config);
try {
  console.log(await createBackup(database, config.backupDir));
} finally {
  database.close();
}
