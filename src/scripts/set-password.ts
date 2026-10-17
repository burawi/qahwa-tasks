import { stdin, stdout } from "node:process";
import { AuthService } from "../server/auth.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/database.js";

async function hiddenPrompt(label: string): Promise<string> {
  stdout.write(label);
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const key of chunk) {
        if (key === "\u0003") {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          reject(new Error("Cancelled"));
          return;
        }
        if (key === "\r" || key === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (key === "\u007f") value = value.slice(0, -1);
        else if (key >= " ") value += key;
      }
    };
    stdin.on("data", onData);
  });
}

const config = loadConfig();
const database = new AppDatabase(config);
try {
  const password = await hiddenPrompt("New Qahwa Tasks password: ");
  const confirmation = stdin.isTTY ? await hiddenPrompt("Confirm password: ") : password;
  if (password !== confirmation) throw new Error("Passwords do not match");
  await new AuthService(database, config.sessionDays, config.publicBaseUrl.startsWith("https://")).setPassword(password);
  stdout.write("Password updated and existing sessions revoked.\n");
} finally {
  database.close();
}
