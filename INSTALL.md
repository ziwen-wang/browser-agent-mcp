# Browser Agent MCP installation

For a concise Chinese first-run walkthrough, see [`FIRST-RUN.md`](./FIRST-RUN.md) in the complete product package.

The product has two parts: the Chrome/Edge extension runs in your existing browser, and the MCP Server is launched on demand by your MCP host. You do not need to keep a terminal or background service open.

## Requirements

- Chrome 116+ or current Chromium-based Microsoft Edge
- Node.js 22+ on the same computer as your MCP host
- An MCP-compatible host that can launch a local stdio server

## 1. Install the browser extension

1. Extract the complete `browser-agent-mcp-<version>.zip` package.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**, choose **Load unpacked**, and select the `extension` folder inside the extracted package.
4. Copy the extension ID shown by the browser.

The extension is a developer/unpacked-install package. A normal one-click store installation is not available until it is published and approved by the Chrome Web Store or Edge Add-ons. The smaller `browser-agent-mcp-extension-<version>.zip` contains only the extension and does not include the MCP server setup wizard.

## 2. Create the MCP host configuration

From the extracted complete product folder, run `setup-mcp.command` on macOS or `setup-mcp.bat` on Windows. The wizard asks for the extension ID, generates a random pairing token, and lets you select Visual Studio Code, Cursor, and/or Claude Desktop. It merges the server into each selected user's global MCP config, preserving unrelated settings and creating a backup before edits. If a `browser-agent` entry already exists, it asks before replacing it. The wizard also creates `mcp-config.json` as a private portable copy of the server config.

After the wizard updates the selected host configs, reload or restart those hosts so they start the local server.

## 3. Pair the extension

1. Click the extension icon and open **Settings**.
2. Paste the pairing token printed by the setup command and save.
3. Restart or reload the MCP host configuration if needed. The host starts the MCP Server process; the extension reconnects to it through `127.0.0.1`.
4. Open a website, click the extension icon, and grant that exact site read-only access. Enable interaction only when needed.

## Where the service runs

The MCP host starts `mcp-server/dist/index.js` as a local stdio process whenever it needs the MCP tools. The server opens a loopback-only WebSocket on port `38741` for the extension. It is not a public/cloud service and does not launch a second browser.

If port `38741` is already in use, change `BROWSER_AGENT_PORT` in the generated host configuration and use the same port in the extension settings.

## Download a release

Download `browser-agent-mcp-<version>.zip` from the project's GitHub Releases page for the complete product, or the smaller `browser-agent-mcp-extension-<version>.zip` if you only need the browser extension package.

## Build packages from source

Run `./build.sh` at the repository root. It builds the extension and server, installs the server's production dependencies into the release bundle, and writes versioned ZIP packages to `release/`.
