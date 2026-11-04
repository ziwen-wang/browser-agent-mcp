import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import { getSupportedHosts, installHostConfig } from "../scripts/host-config.mjs";

test("host discovery returns platform-specific user-level config formats", () => {
  const macHosts = getSupportedHosts({ platform: "darwin", home: "/home/test" });
  assert.deepEqual(macHosts.map(({ id, section }) => [id, section]), [
    ["vscode", "servers"],
    ["cursor", "mcpServers"],
    ["claude", "mcpServers"]
  ]);
  assert.equal(macHosts[0].filePath, "/home/test/Library/Application Support/Code/User/mcp.json");

  const windowsHosts = getSupportedHosts({
    platform: "win32",
    home: "/profile",
    env: { APPDATA: "/roaming" }
  });
  assert.equal(windowsHosts[0].filePath, "/roaming/Code/User/mcp.json");
  assert.equal(windowsHosts[2].filePath, "/roaming/Claude/claude_desktop_config.json");
});

test("host configuration merge preserves JSONC content and backs up before replacing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-agent-host-config-"));
  try {
    const filePath = join(directory, "mcp.json");
    const original = `{
  // Keep the user's existing server.
  "servers": {
    "other": { "command": "node", "args": ["other.js"] },
    "browser-agent": { "command": "old" }
  },
  "custom": true,
}\n`;
    await writeFile(filePath, original);
    const host = { name: "Visual Studio Code", filePath, section: "servers", includeType: true };
    const server = {
      type: "stdio",
      command: "node",
      args: ["/opt/browser-agent/dist/index.js"],
      env: { BROWSER_AGENT_TOKEN: "a".repeat(64) }
    };

    await assert.rejects(installHostConfig(host, server), { code: "SERVER_EXISTS" });
    assert.equal(await readFile(filePath, "utf8"), original);

    const result = await installHostConfig(host, server, { replaceExisting: true });
    const updated = await readFile(filePath, "utf8");
    assert.match(updated, /Keep the user's existing server/);
    assert.match(updated, /"other": \{ "command": "node", "args": \["other.js"\] \}/);
    assert.match(updated, /"custom": true/);
    assert.deepEqual(parse(updated).servers["browser-agent"], server);
    assert.equal(await readFile(result.backupPath, "utf8"), original);
    assert.ok((await readdir(directory)).includes(result.backupPath.split("/").at(-1)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host configuration reuses a matching extension pairing and updates its server path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-agent-host-refresh-"));
  try {
    const filePath = join(directory, "mcp.json");
    const host = { name: "Visual Studio Code", filePath, section: "servers", includeType: true };
    const extensionOrigin = `chrome-extension://${"d".repeat(32)}`;
    const existing = {
      type: "stdio",
      command: "node",
      args: ["/old/browser-agent/dist/index.js"],
      env: {
        BROWSER_AGENT_TOKEN: "e".repeat(64),
        BROWSER_AGENT_EXTENSION_ORIGIN: extensionOrigin,
        BROWSER_AGENT_PORT: "40123",
        EXISTING_CUSTOM_ENV: "keep"
      }
    };
    await writeFile(filePath, JSON.stringify({ servers: { "browser-agent": existing } }, null, 2));
    const candidate = {
      type: "stdio",
      command: "node",
      args: ["/new/browser-agent/dist/index.js"],
      env: {
        BROWSER_AGENT_TOKEN: "f".repeat(64),
        BROWSER_AGENT_EXTENSION_ORIGIN: extensionOrigin,
        BROWSER_AGENT_PORT: "38741"
      }
    };

    const result = await installHostConfig(host, candidate);
    const updated = parse(await readFile(filePath, "utf8")).servers["browser-agent"];
    assert.deepEqual(updated.args, ["/new/browser-agent/dist/index.js"]);
    assert.equal(updated.env.BROWSER_AGENT_TOKEN, existing.env.BROWSER_AGENT_TOKEN);
    assert.equal(updated.env.BROWSER_AGENT_PORT, existing.env.BROWSER_AGENT_PORT);
    assert.equal(updated.env.EXISTING_CUSTOM_ENV, "keep");
    assert.deepEqual(result.serverConfig, updated);
    assert.deepEqual(parse(await readFile(result.backupPath, "utf8")).servers["browser-agent"], existing);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host configuration refuses to rewrite invalid JSONC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-agent-host-invalid-"));
  try {
    const filePath = join(directory, "mcp.json");
    const original = "{ invalid";
    await writeFile(filePath, original);
    await assert.rejects(
      installHostConfig({ name: "Cursor", filePath, section: "mcpServers" }, {}),
      /invalid JSONC/
    );
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["mcp.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host configuration treats an empty existing file as an empty config and backs it up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-agent-empty-config-"));
  try {
    const filePath = join(directory, "mcp.json");
    const host = { name: "Visual Studio Code", filePath, section: "servers", includeType: true };
    const server = {
      type: "stdio",
      command: "node",
      args: ["/opt/browser-agent/dist/index.js"],
      env: { BROWSER_AGENT_TOKEN: "c".repeat(64) }
    };
    await writeFile(filePath, "");

    const result = await installHostConfig(host, server);
    const config = parse(await readFile(filePath, "utf8"));
    assert.deepEqual(config.servers["browser-agent"], server);
    assert.equal(await readFile(result.backupPath, "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cursor receives the mcpServers schema without a VS Code-only type field", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-agent-cursor-config-"));
  try {
    const filePath = join(directory, "mcp.json");
    const host = { name: "Cursor", filePath, section: "mcpServers", includeType: false };
    const server = {
      type: "stdio",
      command: "node",
      args: ["/opt/browser-agent/dist/index.js"],
      env: { BROWSER_AGENT_TOKEN: "b".repeat(64) }
    };
    await installHostConfig(host, server);
    const config = parse(await readFile(filePath, "utf8"));
    assert.equal(config.mcpServers["browser-agent"].type, undefined);
    assert.equal(config.mcpServers["browser-agent"].env.BROWSER_AGENT_TOKEN, server.env.BROWSER_AGENT_TOKEN);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
