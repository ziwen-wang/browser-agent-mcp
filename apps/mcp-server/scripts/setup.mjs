#!/usr/bin/env node
import { constants } from "node:fs";
import { copyFile, chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getExistingHostServer, getSupportedHosts, installHostConfig } from "./host-config.mjs";
import { randomBytes } from "node:crypto";

const extensionIdArgument = process.argv[2];
const outputPath = resolve(process.argv[3] ?? "mcp-config.json");
const interactive = process.stdin.isTTY && process.stdout.isTTY;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: node setup.mjs [chrome-extension-id] [output-config.json]\n");
  process.exit(0);
}

const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
try {
  if (prompt) printHeader();
  const detectedExtensionId = extensionIdArgument ? undefined : await detectExistingExtensionId(outputPath);
  const idPrompt = detectedExtensionId
    ? `检测到已有扩展 ID ${detectedExtensionId}；回车复用，或粘贴新的 32 位 ID: `
    : "扩展 ID（从 chrome://extensions 复制 32 位 ID）: ";
  const extensionId = (extensionIdArgument ?? (prompt
    ? await prompt.question(idPrompt)
    : detectedExtensionId ?? "")).trim() || detectedExtensionId || "";
  if (!/^[a-p]{32}$/.test(extensionId)) {
    process.stderr.write("扩展 ID 无效：请从 chrome://extensions 或 edge://extensions 复制完整的 32 位 ID。\n");
    process.exitCode = 2;
  } else {
    if (prompt) process.stdout.write("\n[1/3] 检查配对信息\n");
    const setupDirectory = dirname(fileURLToPath(import.meta.url));
    const serverDirectory = basename(setupDirectory) === "scripts" ? dirname(setupDirectory) : setupDirectory;
    const serverPath = join(serverDirectory, "dist", "index.js");
    const hostPairing = await findExistingHostPairing(extensionId);
    const serverConfig = await loadOrCreateServerConfig({ extensionId, outputPath, serverPath, hostPairing, prompt });
    process.stdout.write(`配对配置：${outputPath}\n`);

    if (prompt) await configureHosts(prompt, serverConfig);

    const token = serverConfig.env.BROWSER_AGENT_TOKEN;
    process.stdout.write(`\n[3/3] 配对密钥（复制到扩展设置中）\n${token}\n`);
    process.stdout.write(`请勿分享 ${basename(outputPath)}，其中包含配对密钥。\n`);
  }
} catch (error) {
  process.stderr.write(`\n配置失败：${error.message}\n`);
  process.exitCode = 1;
} finally {
  prompt?.close();
}

function printHeader() {
  process.stdout.write(
    "Browser Agent MCP | 配对向导\n" +
    "================================\n" +
    "先加载浏览器扩展，再按步骤检查已有配对并配置 MCP Host。\n\n"
  );
}

async function findExistingHostPairing(extensionId) {
  const origin = `chrome-extension://${extensionId}`;
  const pairings = [];
  for (const host of getSupportedHosts()) {
    try {
      const server = await getExistingHostServer(host);
      if (server?.env?.BROWSER_AGENT_EXTENSION_ORIGIN === origin && hasValidPairing(server)) {
        pairings.push(server);
      }
    } catch (error) {
      if (error?.code !== "INVALID_CONFIG") throw error;
    }
  }
  const first = pairings[0];
  if (pairings.some((server) =>
    server.env.BROWSER_AGENT_TOKEN !== first.env.BROWSER_AGENT_TOKEN ||
    server.env.BROWSER_AGENT_PORT !== first.env.BROWSER_AGENT_PORT)) {
    throw new Error("多个 MCP Host 为此扩展配置了不同密钥或端口。请先统一现有配对；尚未修改任何配置。");
  }
  return first;
}

async function detectExistingExtensionId(outputPath) {
  const extensionIds = new Set();
  try {
    const config = JSON.parse(await readFile(outputPath, "utf8"));
    addExtensionId(extensionIds, config?.servers?.["browser-agent"]?.env?.BROWSER_AGENT_EXTENSION_ORIGIN);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  for (const host of getSupportedHosts()) {
    try {
      const server = await getExistingHostServer(host);
      addExtensionId(extensionIds, server?.env?.BROWSER_AGENT_EXTENSION_ORIGIN);
    } catch (error) {
      if (error?.code !== "INVALID_CONFIG") throw error;
    }
  }

  return extensionIds.size === 1 ? [...extensionIds][0] : undefined;
}

function addExtensionId(extensionIds, origin) {
  const match = typeof origin === "string" && /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (match) extensionIds.add(match[1]);
}

async function loadOrCreateServerConfig({ extensionId, outputPath, serverPath, hostPairing, prompt }) {
  let existingText;
  try {
    existingText = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (existingText !== undefined) {
    let existing;
    try {
      existing = JSON.parse(existingText);
    } catch {
      throw new Error(`${outputPath} is not valid JSON. Rename or repair it before running setup.`);
    }
    const server = existing?.servers?.["browser-agent"];
    if (server?.env?.BROWSER_AGENT_EXTENSION_ORIGIN === `chrome-extension://${extensionId}` &&
      hasValidPairing(server)) {
      if (!prompt) throw new Error(`${outputPath} already exists. Move it or provide a different output path.`);
      process.stdout.write(hostPairing
        ? "已从 MCP Host 找到当前扩展的配对，优先沿用 Host 中的密钥。\n"
        : "已找到相同扩展 ID 的配对，沿用现有密钥。\n");
      const refreshedServer = {
        ...server,
        type: "stdio",
        command: process.execPath,
        args: [serverPath],
        env: {
          ...(hostPairing?.env ?? server.env),
          BROWSER_AGENT_EXTENSION_ORIGIN: `chrome-extension://${extensionId}`,
          BROWSER_AGENT_PORT: hostPairing?.env?.BROWSER_AGENT_PORT ?? server.env.BROWSER_AGENT_PORT
        }
      };
      if (JSON.stringify(server) !== JSON.stringify(refreshedServer)) {
        existing.servers["browser-agent"] = refreshedServer;
        await persistPairingConfig(outputPath, existing);
      }
      return refreshedServer;
    }

    if (!prompt || !(await confirm(prompt, `\n${outputPath} 中保存的是其他扩展的配对。\n是否先备份，再为当前扩展写入配对？[y/N] `))) {
      throw new Error(`${outputPath} 中的配对与当前扩展不匹配，文件未更改。`);
    }
    const backupPath = await createBackup(outputPath);
    process.stdout.write(`旧配对已备份：${backupPath}\n`);
  } else if (hostPairing && prompt) {
    process.stdout.write("已从 MCP Host 检测到当前扩展的配对，沿用原密钥和端口。\n");
  } else if (prompt) {
    process.stdout.write("未找到已有配对，将生成新的密钥。\n");
  }

  const server = {
    type: "stdio",
    command: process.execPath,
    args: [serverPath],
    env: {
      ...(hostPairing?.env ?? {}),
      BROWSER_AGENT_TOKEN: hostPairing?.env?.BROWSER_AGENT_TOKEN ?? randomBytes(32).toString("hex"),
      BROWSER_AGENT_EXTENSION_ORIGIN: `chrome-extension://${extensionId}`,
      BROWSER_AGENT_PORT: hostPairing?.env?.BROWSER_AGENT_PORT ?? "38741"
    }
  };
  const config = { servers: { "browser-agent": server } };
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
    flag: existingText === undefined ? "wx" : "w",
    mode: 0o600
  });
  if (process.platform !== "win32") await chmod(outputPath, 0o600);
  return server;
}

async function configureHosts(prompt, serverConfig) {
  const hosts = getSupportedHosts();
  process.stdout.write("\n[2/3] 检查 MCP Host 配置\n");
  const hostStates = [];
  for (const host of hosts) {
    try {
      const existing = await getExistingHostServer(host);
      hostStates.push({
        host,
        existing,
        matchesExtension: existing?.env?.BROWSER_AGENT_EXTENSION_ORIGIN === serverConfig.env.BROWSER_AGENT_EXTENSION_ORIGIN
      });
    } catch (error) {
      if (error?.code !== "INVALID_CONFIG") throw error;
      process.stderr.write(`${error.message}\n`);
      hostStates.push({ host, error });
    }
  }

  for (const [index, state] of hostStates.entries()) {
    const status = state.error
      ? "配置无效，将跳过"
      : state.matchesExtension
        ? hasValidPairing(state.existing)
          ? "已配置此扩展，将复用密钥并更新"
          : "检测到此扩展，将修复配对配置"
        : state.existing
          ? "已有其他 Browser Agent 配置"
          : "未配置";
    process.stdout.write(`  ${index + 1}. ${state.host.name}  [${status}]\n`);
  }
  const detectedSelections = hostStates
    .map((state, index) => state.matchesExtension && !state.error ? index + 1 : undefined)
    .filter((selection) => selection !== undefined);
  if (detectedSelections.length > 0) {
    process.stdout.write("检测到当前扩展已配置；直接按回车即可原位更新，无需重新输入密钥。\n");
  }
  process.stdout.write("输入序号（多个用逗号分隔），0 跳过");
  if (detectedSelections.length > 0) process.stdout.write("，回车更新已检测到的配置");
  process.stdout.write("： ");
  const answer = (await prompt.question("")).trim();
  const selections = answer
    ? answer === "0" ? [] : [...new Set(answer.split(",").map((value) => Number(value.trim())))]
    : detectedSelections;
  if (selections.length === 0) {
    if (answer !== "0" && detectedSelections.length === 0) {
      process.stdout.write("未选择 MCP Host；保留 mcp-config.json，可稍后重新运行向导。\n");
    }
    return;
  }
  if (selections.some((value) => !Number.isInteger(value) || value < 1 || value > hosts.length)) {
    throw new Error(`输入有效序号：1-${hosts.length}，多个序号用逗号分隔；输入 0 可跳过。`);
  }

  const selectedHosts = selections.map((selection) => hosts[selection - 1]);
  const configurableHosts = [];
  const matchingPairings = [];
  for (const host of selectedHosts) {
    let existing;
    try {
      existing = await getExistingHostServer(host);
    } catch (error) {
      if (error?.code !== "INVALID_CONFIG") throw error;
      process.stderr.write(`${error.message}\nSkipped ${host.name}; no changes were made to its configuration.\n`);
      continue;
    }
    configurableHosts.push(host);
    if (existing?.env?.BROWSER_AGENT_EXTENSION_ORIGIN === serverConfig.env.BROWSER_AGENT_EXTENSION_ORIGIN &&
      hasValidPairing(existing)) {
      matchingPairings.push(existing);
    }
  }
  const matchingPairing = matchingPairings[0];
  if (matchingPairings.some((existing) =>
    existing.env.BROWSER_AGENT_TOKEN !== matchingPairing.env.BROWSER_AGENT_TOKEN ||
    existing.env.BROWSER_AGENT_PORT !== matchingPairing.env.BROWSER_AGENT_PORT)) {
    throw new Error("Selected MCP Hosts already contain different pairings for this extension ID. No host configuration was changed; reconcile their pairing tokens first.");
  }
  if (matchingPairing) {
    serverConfig.env.BROWSER_AGENT_TOKEN = matchingPairing.env.BROWSER_AGENT_TOKEN;
    serverConfig.env.BROWSER_AGENT_PORT = matchingPairing.env.BROWSER_AGENT_PORT;
    await syncPairingConfig(outputPath, serverConfig);
    process.stdout.write("复用 Host 中已有的配对密钥；更新时会保留该密钥和端口。\n");
  }

  for (const host of configurableHosts) {
    try {
      const result = await installHostConfig(host, serverConfig);
      Object.assign(serverConfig, result.serverConfig);
      Object.assign(serverConfig.env, result.serverConfig.env);
      const alreadyConfigured = hostStates.find((state) => state.host.id === host.id)?.matchesExtension;
      reportInstalledHost(host, result, alreadyConfigured ? "已更新" : "已配置");
    } catch (error) {
      if (error?.code === "INVALID_CONFIG") {
        process.stderr.write(`${error.message}\nSkipped ${host.name}; no changes were made to its configuration.\n`);
        continue;
      }
      if (error?.code !== "SERVER_EXISTS") throw error;
      if (isSamePairing(error.existingConfig, serverConfig)) {
        process.stdout.write(`${host.name} already has this pairing; left unchanged: ${host.filePath}\n`);
        continue;
      }
      const replaceExisting = await confirm(
        prompt,
        `\n${host.name} 已配置其他扩展的 Browser Agent。\n是否先备份，再替换该项？[y/N] `
      );
      if (!replaceExisting) {
        process.stdout.write(`已跳过 ${host.name}；现有配置保持不变。\n`);
        continue;
      }
      const result = await installHostConfig(host, serverConfig, { replaceExisting: true });
      Object.assign(serverConfig, result.serverConfig);
      Object.assign(serverConfig.env, result.serverConfig.env);
      reportInstalledHost(host, result, "已替换");
    }
  }
}

async function syncPairingConfig(configPath, serverConfig) {
  const text = await readFile(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${configPath} is not valid JSON. It was not changed.`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${configPath} must contain a JSON object. It was not changed.`);
  }
  const currentServer = config.servers?.["browser-agent"];
  if (currentServer?.env?.BROWSER_AGENT_EXTENSION_ORIGIN !== serverConfig.env.BROWSER_AGENT_EXTENSION_ORIGIN) {
    throw new Error(`${configPath} does not match the selected extension ID. It was not changed.`);
  }
  if (JSON.stringify(currentServer) === JSON.stringify(serverConfig)) return;

  config.servers["browser-agent"] = serverConfig;
  await persistPairingConfig(configPath, config);
}

async function persistPairingConfig(configPath, config) {
  const backupPath = await createBackup(configPath);
  process.stdout.write(`旧配对配置已备份：${backupPath}\n`);
  const temporary = `${configPath}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, configPath);
    if (process.platform !== "win32") await chmod(configPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function reportInstalledHost(host, result, action) {
  process.stdout.write(`${action}：${host.name}\n  配置文件：${result.filePath}\n`);
  if (result.backupPath) process.stdout.write(`  备份文件：${result.backupPath}\n`);
}

function hasValidPairing(server) {
  const port = server?.env?.BROWSER_AGENT_PORT;
  return typeof server?.env?.BROWSER_AGENT_TOKEN === "string" &&
    Buffer.byteLength(server.env.BROWSER_AGENT_TOKEN) >= 32 &&
    typeof port === "string" && /^\d+$/.test(port) &&
    Number(port) >= 1024 && Number(port) <= 65535;
}

function isSamePairing(existing, candidate) {
  return existing?.env?.BROWSER_AGENT_TOKEN === candidate.env.BROWSER_AGENT_TOKEN &&
    existing?.env?.BROWSER_AGENT_EXTENSION_ORIGIN === candidate.env.BROWSER_AGENT_EXTENSION_ORIGIN &&
    existing?.env?.BROWSER_AGENT_PORT === candidate.env.BROWSER_AGENT_PORT;
}

async function confirm(prompt, message) {
  const answer = (await prompt.question(message)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function createBackup(filePath) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  let suffix = 0;
  while (true) {
    const candidate = `${filePath}.browser-agent-backup-${stamp}${suffix ? `-${suffix}` : ""}`;
    try {
      await copyFile(filePath, candidate, constants.COPYFILE_EXCL);
      if (process.platform !== "win32") await chmod(candidate, 0o600);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      suffix += 1;
    }
  }
}
