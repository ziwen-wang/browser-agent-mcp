import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BRIDGE_REQUEST_TIMEOUT_MS } from "@browser-agent-mcp/protocol";
import type { BridgeMessage, BridgeReply, ExtensionCall, ExtensionRequest } from "@browser-agent-mcp/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const host = "127.0.0.1";
const port = Number(process.env.BROWSER_AGENT_PORT ?? "38741");
const token = process.env.BROWSER_AGENT_TOKEN ?? "";
const allowedOrigin = process.env.BROWSER_AGENT_EXTENSION_ORIGIN ?? "";

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("BROWSER_AGENT_PORT must be an integer between 1024 and 65535.");
}
if (Buffer.byteLength(token, "utf8") < 32) {
  throw new Error("Set BROWSER_AGENT_TOKEN to a random secret of at least 32 bytes.");
}
if (!/^chrome-extension:\/\/[a-p]{32}$/.test(allowedOrigin)) {
  throw new Error("Set BROWSER_AGENT_EXTENSION_ORIGIN to the exact 32-character Chrome extension origin.");
}

const httpServer = createServer((_request, response) => {
  response.writeHead(404);
  response.end();
});
const websocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024 * 1024,
  perMessageDeflate: false
});

let extensionSocket: WebSocket | undefined;
let extensionAuthenticated = false;
const pending = new Map<string, (reply: Extract<BridgeReply, { type: "response" }>) => void>();
let requestCount = 0;
let windowStarted = Date.now();

httpServer.on("upgrade", (request, socket, head) => {
  const expectedHost = `${host}:${port}`;
  if (request.url !== "/bridge" || request.headers.host !== expectedHost || request.headers.origin !== allowedOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit("connection", websocket);
  });
});

websocketServer.on("connection", (websocket) => {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    websocket.close(1013, "An extension is already connected.");
    return;
  }

  extensionSocket = websocket;
  extensionAuthenticated = false;
  const authTimer = setTimeout(() => websocket.close(1008, "Authentication timeout."), 5000);
  let authenticated = false;

  websocket.on("message", (data, isBinary) => {
    if (isBinary) {
      websocket.close(1003, "Binary messages are not supported.");
      return;
    }

    let message: BridgeMessage | BridgeReply;
    try {
      message = JSON.parse(data.toString()) as BridgeMessage | BridgeReply;
    } catch {
      websocket.close(1007, "Invalid JSON.");
      return;
    }

    if (!authenticated) {
      if (!isHello(message) || !constantTimeEqual(message.token, token)) {
        websocket.close(1008, "Invalid pairing token.");
        return;
      }
      authenticated = true;
      extensionAuthenticated = true;
      clearTimeout(authTimer);
      websocket.send(JSON.stringify({ type: "ready" }));
      console.error("Browser extension paired.");
      return;
    }

    if (isKeepalive(message)) return;
    if (isResponse(message)) {
      pending.get(message.id)?.(message);
      return;
    }
    websocket.close(1008, "Unexpected message from extension.");
  });

  websocket.on("close", () => {
    clearTimeout(authTimer);
    if (extensionSocket === websocket) {
      extensionSocket = undefined;
      extensionAuthenticated = false;
    }
    for (const resolve of pending.values()) {
      resolve({ type: "response", id: "", ok: false, error: "Browser extension disconnected." });
    }
    pending.clear();
    console.error("Browser extension disconnected.");
  });

  websocket.on("error", (error) => console.error("Browser bridge error:", error.message));
});

function isHello(message: BridgeMessage | BridgeReply): message is { type: "hello"; token: string } {
  return "type" in message && message.type === "hello" && "token" in message && typeof message.token === "string";
}

function isResponse(message: BridgeMessage | BridgeReply): message is Extract<BridgeReply, { type: "response" }> {
  if (!("type" in message) || message.type !== "response" || !("id" in message) || typeof message.id !== "string") return false;
  if (!("ok" in message) || typeof message.ok !== "boolean") return false;
  return message.ok ? "result" in message : "error" in message && typeof message.error === "string";
}

function isKeepalive(message: BridgeMessage | BridgeReply): boolean {
  return "type" in message && message.type === "keepalive";
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function callExtension(request: ExtensionCall): Promise<unknown> {
  const socket = extensionSocket;
  if (!socket || !extensionAuthenticated || socket.readyState !== WebSocket.OPEN) {
    throw new Error("No browser extension is connected. Open the extension and configure its pairing token.");
  }
  if (Date.now() - windowStarted > 10_000) {
    requestCount = 0;
    windowStarted = Date.now();
  }
  if (++requestCount > 60) throw new Error("Browser bridge rate limit exceeded.");

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Browser action timed out."));
    }, BRIDGE_REQUEST_TIMEOUT_MS);

    pending.set(id, (reply) => {
      clearTimeout(timer);
      pending.delete(id);
      if (!reply.ok) reject(new Error(reply.error));
      else resolve(reply.result);
    });

    try {
      socket.send(JSON.stringify({ ...request, type: "request", id }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error("Could not send request to the browser extension."));
    }
  });
}

const server = new McpServer({ name: "browser-agent-mcp", version: "0.1.0" });

function registerTool(
  name: string,
  description: string,
  schema: Record<string, z.ZodType>,
  method: ExtensionRequest["method"],
  params: (input: Record<string, unknown>) => Record<string, unknown>
) {
  server.tool(name, description, schema, async (input) => {
    try {
      const result = await callExtension({ method, params: params(input) } as ExtensionCall);
      if (method === "page.screenshot" && isScreenshot(result)) {
        return {
          content: [{ type: "image", data: result.base64, mimeType: result.mimeType }]
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "Browser operation failed." }]
      };
    }
  });
}

function isScreenshot(value: unknown): value is { base64: string; mimeType: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { base64?: unknown; mimeType?: unknown };
  return typeof candidate.base64 === "string" && typeof candidate.mimeType === "string";
}

registerTool(
  "browser_tabs_list",
  "List the active browser tab. Requires an explicitly authorized website origin.",
  {},
  "tabs.list",
  () => ({})
);
registerTool(
  "browser_page_inspect",
  "Read a bounded DOM/text summary and accessible interactive elements from the active tab. Read-only.",
  { tabId: z.number().int().positive().optional() },
  "page.inspect",
  (input) => ({ tabId: input.tabId })
);
registerTool(
  "browser_page_click",
  "Click an element identified by a selector from a recent inspect result. Always requires explicit user confirmation.",
  {
    tabId: z.number().int().positive().optional(),
    selector: z.string().min(1).max(2000),
    expectedTag: z.string().min(1).max(32),
    expectedName: z.string().max(200)
  },
  "page.click",
  (input) => ({
    tabId: input.tabId,
    selector: input.selector,
    expectedTag: input.expectedTag,
    expectedName: input.expectedName
  })
);
registerTool(
  "browser_page_fill",
  "Fill a non-sensitive form field. Requires per-action confirmation unless fill is explicitly allowlisted for this exact origin.",
  {
    tabId: z.number().int().positive().optional(),
    selector: z.string().min(1).max(2000),
    value: z.string().max(4000),
    expectedTag: z.string().min(1).max(32),
    expectedName: z.string().max(200)
  },
  "page.fill",
  (input) => ({
    tabId: input.tabId,
    selector: input.selector,
    value: input.value,
    expectedTag: input.expectedTag,
    expectedName: input.expectedName
  })
);
registerTool(
  "browser_page_select",
  "Choose an option in a select field. Requires explicit confirmation because the selection may trigger page behavior.",
  {
    tabId: z.number().int().positive().optional(),
    selector: z.string().min(1).max(2000),
    value: z.string().max(1000),
    expectedName: z.string().max(200)
  },
  "page.select",
  (input) => ({
    tabId: input.tabId,
    selector: input.selector,
    value: input.value,
    expectedName: input.expectedName
  })
);
registerTool(
  "browser_page_scroll",
  "Scroll the currently authorized page by at most 1000 pixels. This does not click or submit anything.",
  {
    tabId: z.number().int().positive().optional(),
    deltaY: z.number().int().min(-1000).max(1000)
  },
  "page.scroll",
  (input) => ({ tabId: input.tabId, deltaY: input.deltaY })
);
registerTool(
  "browser_tabs_navigate",
  "Navigate the active tab to an HTTP(S) URL. Always requires explicit user confirmation.",
  {
    tabId: z.number().int().positive().optional(),
    url: z.string().url().max(2048)
  },
  "tabs.navigate",
  (input) => ({ tabId: input.tabId, url: input.url })
);
registerTool(
  "browser_page_screenshot",
  "Capture the visible active tab. Requires the optional tabs permission to be granted by the user in extension settings.",
  { tabId: z.number().int().positive().optional() },
  "page.screenshot",
  (input) => ({ tabId: input.tabId })
);

await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(port, host, resolve);
});
console.error(`Browser bridge listening on ws://${host}:${port}/bridge`);
console.error(`Allowed extension origin: ${allowedOrigin}`);

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    websocketServer.close();
    httpServer.close();
    process.exit(0);
  });
}
