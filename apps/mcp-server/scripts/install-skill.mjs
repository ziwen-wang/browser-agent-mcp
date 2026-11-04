#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceCandidates = [
  resolve(scriptDirectory, "../../../skills/browser-agent-mcp/SKILL.md"),
  resolve(scriptDirectory, "../skills/browser-agent-mcp/SKILL.md"),
  resolve(scriptDirectory, "../../skills/browser-agent-mcp/SKILL.md")
];
let source;
for (const candidate of sourceCandidates) {
  try { await readFile(candidate, "utf8"); source = candidate; break; } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
if (!source) throw new Error("Bundled Browser Agent MCP skill was not found.");
const destination = resolve(process.argv[2] ?? join(homedir(), ".codex", "skills", "browser-agent-mcp", "SKILL.md"));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: node install-skill.mjs [destination-SKILL.md]\nDefault: ~/.codex/skills/browser-agent-mcp/SKILL.md\n");
  process.exit(0);
}
const content = await readFile(source, "utf8");
await mkdir(dirname(destination), { recursive: true });
try {
  await readFile(destination, "utf8");
  process.stderr.write(`Skill already exists; left unchanged: ${destination}\n`);
  process.exit(2);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const temporary = `${destination}.${process.pid}.tmp`;
try {
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, destination);
  if (process.platform !== "win32") await chmod(destination, 0o600);
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
}
process.stdout.write(`Installed Browser Agent MCP skill: ${destination}\nRestart Codex to load the skill.\n`);
