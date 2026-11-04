#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionId = process.argv[2];
const outputPath = resolve(process.argv[3] ?? "mcp-config.json");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: node setup.mjs <chrome-extension-id> [output-config.json]\n");
  process.exit(0);
}

if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  process.stderr.write(
    "Provide the 32-character extension ID shown on chrome://extensions or edge://extensions.\n"
  );
  process.exit(2);
}

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "dist", "index.js");
const token = randomBytes(32).toString("hex");
const config = {
  servers: {
    "browser-agent": {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {
        BROWSER_AGENT_TOKEN: token,
        BROWSER_AGENT_EXTENSION_ORIGIN: `chrome-extension://${extensionId}`,
        BROWSER_AGENT_PORT: "38741"
      }
    }
  }
};

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
if (process.platform !== "win32") await chmod(outputPath, 0o600);
process.stdout.write(`MCP host config created: ${outputPath}\n`);
process.stdout.write(`Pairing token (paste into the extension settings): ${token}\n`);
process.stdout.write(`Copy the "browser-agent" entry from ${basename(outputPath)} into your MCP host configuration.\n`);
