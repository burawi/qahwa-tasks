import { randomUUID } from "node:crypto";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/database.js";

const instruction = process.env.ORCHESTRATOR_DIRECTIVE?.trim();
const sourceQuote = process.env.ORCHESTRATOR_SOURCE_QUOTE?.trim();
if (!instruction || !sourceQuote) throw new Error("ORCHESTRATOR_DIRECTIVE and ORCHESTRATOR_SOURCE_QUOTE are required");

const database = new AppDatabase(loadConfig());
try {
  database.setSetting("orchestrator_standing_directive", JSON.stringify({
    id: randomUUID(),
    instruction: instruction.slice(0, 2_000),
    sourceQuote: sourceQuote.slice(0, 2_000),
    createdAt: new Date().toISOString(),
  }));
  process.stdout.write("Standing orchestrator directive saved.\n");
} finally {
  database.close();
}
