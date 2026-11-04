import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function openSocket(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    const onError = (error) => {
      socket.removeAllListeners();
      reject(error);
    };
    socket.once("open", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
    socket.once("error", onError);
  });
}

test("MCP server enforces extension origin and token, then forwards tools over the bridge", { timeout: 25_000 }, async () => {
  const port = await unusedPort();
  const token = "b".repeat(64);
  const origin = `chrome-extension://${"a".repeat(32)}`;
  const serverFile = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverFile],
    env: {
      ...process.env,
      BROWSER_AGENT_PORT: String(port),
      BROWSER_AGENT_TOKEN: token,
      BROWSER_AGENT_EXTENSION_ORIGIN: origin
    }
  });
  const client = new Client({ name: "bridge-test", version: "1.0.0" }, { capabilities: {} });
  let browser;

  try {
    await client.connect(transport);

    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/bridge`, "https://attacker.example"));
    browser = await openSocket(`ws://127.0.0.1:${port}/bridge`, origin);
    const rejectedAuthentication = new Promise((resolve) => browser.once("close", resolve));
    browser.send(JSON.stringify({ type: "hello", token: "c".repeat(64) }));
    await rejectedAuthentication;

    browser = await openSocket(`ws://127.0.0.1:${port}/bridge`, origin);
    const authenticated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bridge authentication timed out.")), 3000);
      browser.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
    browser.send(JSON.stringify({ type: "hello", token }));
    assert.deepEqual(await authenticated, { type: "ready" });

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "browser_page_inspect"));
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Tool request was not forwarded.")), 3000);
      browser.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
    const resultPromise = client.callTool({ name: "browser_page_inspect", arguments: {} });
    const request = await response;
    assert.equal(request.type, "request");
    assert.equal(request.method, "page.inspect");
    browser.send(JSON.stringify({
      type: "response",
      id: request.id,
      ok: true,
      result: { title: "Test page", text: "read-only snapshot" }
    }));
    const result = await resultPromise;
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /read-only snapshot/);
  } finally {
    browser?.close();
    await client.close().catch(() => undefined);
  }
});
