import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const setupPath = fileURLToPath(new URL("../scripts/setup.mjs", import.meta.url));
const installSkillPath = fileURLToPath(new URL("../scripts/install-skill.mjs", import.meta.url));

test("skill installer copies the bundled skill to a chosen directory and preserves existing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-agent-skill-"));
  try {
    const destination = join(directory, "skills", "browser-agent-mcp", "SKILL.md");
    const installed = spawnSync(process.execPath, [installSkillPath, destination], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(await readFile(destination, "utf8"), /browser_tabs_list/);
    const collision = spawnSync(process.execPath, [installSkillPath, destination], { encoding: "utf8" });
    assert.equal(collision.status, 2);
    assert.match(collision.stderr, /left unchanged/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup creates a private MCP host config paired to the installed extension ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-agent-setup-"));
  try {
    const configPath = join(directory, "mcp-config.json");
    const result = spawnSync(process.execPath, [setupPath, "a".repeat(32), configPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const server = config.servers["browser-agent"];
    assert.equal(server.command, process.execPath);
    assert.equal(server.env.BROWSER_AGENT_EXTENSION_ORIGIN, `chrome-extension://${"a".repeat(32)}`);
    assert.equal(server.env.BROWSER_AGENT_PORT, "38741");
    assert.match(server.env.BROWSER_AGENT_TOKEN, /^[a-f0-9]{64}$/);
    assert.equal(server.args[0], join(dirname(dirname(setupPath)), "dist", "index.js"));
    assert.match(result.stdout, new RegExp(server.env.BROWSER_AGENT_TOKEN));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const collision = spawnSync(process.execPath, [setupPath, "a".repeat(32), configPath], { encoding: "utf8" });
    assert.notEqual(collision.status, 0);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).servers["browser-agent"].env.BROWSER_AGENT_TOKEN, server.env.BROWSER_AGENT_TOKEN);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup rejects malformed extension IDs", () => {
  const result = spawnSync(process.execPath, [setupPath, "not-an-extension-id"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /32 位 ID/);
});
