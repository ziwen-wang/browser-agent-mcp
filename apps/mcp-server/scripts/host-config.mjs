import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

export function getSupportedHosts({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const configs = {
    darwin: [
      { id: "vscode", name: "Visual Studio Code", filePath: join(home, "Library", "Application Support", "Code", "User", "mcp.json"), section: "servers", includeType: true },
      { id: "cursor", name: "Cursor", filePath: join(home, ".cursor", "mcp.json"), section: "mcpServers", includeType: false },
      { id: "claude", name: "Claude Desktop", filePath: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), section: "mcpServers", includeType: false }
    ],
    win32: [
      { id: "vscode", name: "Visual Studio Code", filePath: join(appData, "Code", "User", "mcp.json"), section: "servers", includeType: true },
      { id: "cursor", name: "Cursor", filePath: join(home, ".cursor", "mcp.json"), section: "mcpServers", includeType: false },
      { id: "claude", name: "Claude Desktop", filePath: join(appData, "Claude", "claude_desktop_config.json"), section: "mcpServers", includeType: false }
    ],
    linux: [
      { id: "vscode", name: "Visual Studio Code", filePath: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Code", "User", "mcp.json"), section: "servers", includeType: true },
      { id: "cursor", name: "Cursor", filePath: join(home, ".cursor", "mcp.json"), section: "mcpServers", includeType: false },
      { id: "claude", name: "Claude Desktop", filePath: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json"), section: "mcpServers", includeType: false }
    ]
  };
  return configs[platform] ?? configs.linux;
}

export async function getExistingHostServer(host) {
  let original;
  try {
    original = await readFile(host.filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }

  const current = parseConfig(original, host.filePath);
  return current[host.section]?.["browser-agent"];
}

export async function installHostConfig(host, serverConfig, { replaceExisting = false } = {}) {
  let original;
  try {
    original = await readFile(host.filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const text = original ?? "{}\n";
  const current = parseConfig(text, host.filePath);
  const section = current[host.section];
  const existingServer = section?.["browser-agent"];
  const expectedOrigin = serverConfig.env?.BROWSER_AGENT_EXTENSION_ORIGIN;
  const matchesExtension = typeof expectedOrigin === "string" &&
    existingServer?.env?.BROWSER_AGENT_EXTENSION_ORIGIN === expectedOrigin;
  const existingToken = existingServer?.env?.BROWSER_AGENT_TOKEN;
  const existingPort = existingServer?.env?.BROWSER_AGENT_PORT;
  const canReusePairing = matchesExtension &&
    typeof existingToken === "string" && Buffer.byteLength(existingToken) >= 32 &&
    typeof existingPort === "string" && /^\d+$/.test(existingPort) &&
    Number(existingPort) >= 1024 && Number(existingPort) <= 65535;
  if (existingServer && !replaceExisting && !matchesExtension) {
    const error = new Error(`${host.name} already has a browser-agent entry.`);
    error.code = "SERVER_EXISTS";
    error.existingConfig = existingServer;
    throw error;
  }

  const useTabs = /^\t/m.test(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hostServerConfig = existingServer && matchesExtension
    ? canReusePairing
      ? {
        ...existingServer,
        ...serverConfig,
        env: {
          ...existingServer.env,
          ...serverConfig.env,
          BROWSER_AGENT_TOKEN: existingToken,
          BROWSER_AGENT_EXTENSION_ORIGIN: existingServer.env.BROWSER_AGENT_EXTENSION_ORIGIN,
          BROWSER_AGENT_PORT: existingPort
        }
      }
      : {
          ...existingServer,
          ...serverConfig,
          env: { ...existingServer.env, ...serverConfig.env }
        }
    : { ...serverConfig };
  if (!host.includeType) delete hostServerConfig.type;
  if (section !== undefined && (!section || typeof section !== "object" || Array.isArray(section))) {
    throw new Error(`Cannot safely update ${host.filePath}: "${host.section}" must be an object.`);
  }
  const edits = modify(text, [host.section, "browser-agent"], hostServerConfig, {
    formattingOptions: { insertSpaces: !useTabs, tabSize: 2, eol }
  });
  const updated = applyEdits(text, edits);
  parseConfig(updated, host.filePath);
  if (updated === text) {
    return { filePath: host.filePath, serverConfig: hostServerConfig };
  }

  await mkdir(dirname(host.filePath), { recursive: true });
  let backupPath;
  if (original !== undefined) {
    backupPath = await createBackup(host.filePath);
  }

  const temporary = `${host.filePath}.browser-agent-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, host.filePath);
    if (process.platform !== "win32") await chmod(host.filePath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { filePath: host.filePath, backupPath, serverConfig: hostServerConfig };
}

function parseConfig(text, filePath) {
  if (text.trim() === "") return {};

  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const offset = errors[0].offset;
    const beforeError = text.slice(0, offset);
    const line = beforeError.split(/\r\n|\r|\n/).length;
    const column = offset - Math.max(beforeError.lastIndexOf("\n"), beforeError.lastIndexOf("\r"));
    const error = new Error(`Cannot safely update ${filePath}: configuration contains invalid JSONC near line ${line}, column ${column}.`);
    error.code = "INVALID_CONFIG";
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error(`Cannot safely update ${filePath}: the configuration root must be an object.`);
    error.code = "INVALID_CONFIG";
    throw error;
  }
  return value;
}

async function createBackup(filePath) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  let suffix = 0;
  while (true) {
    const candidate = `${filePath}.browser-agent-backup-${stamp}${suffix ? `-${suffix}` : ""}`;
    try {
      await copyFile(filePath, candidate, constants.COPYFILE_EXCL);
      if (process.platform !== "win32") {
        await chmod(candidate, 0o600);
      }
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      suffix += 1;
    }
  }
}
