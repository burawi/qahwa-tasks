import { spawnSync } from "node:child_process";
import { loadConfig } from "../server/config.js";
import { createDeploymentBackup } from "../server/deployment-backup.js";

const taskId = process.argv[2]?.trim().toUpperCase();
if (!taskId || !/^[A-Z][A-Z0-9_-]*-\d+$/.test(taskId) || process.argv.length !== 3) {
  throw new Error("Usage: npm run deploy:self -- QAH-0001");
}

const directory = await createDeploymentBackup(loadConfig(), taskId);
console.log(`Pre-deployment snapshot verified: ${directory}`);
const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`Deployment build failed (${build.signal ?? build.status}); restart was not requested`);

// Keep the existing deferred restart mechanism: this only writes its request,
// which the running application handles after the task's turn is complete.
await import("./request-self-deploy.js");
