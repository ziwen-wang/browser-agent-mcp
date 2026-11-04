import { zipSync } from "fflate";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(root, "release");
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const serverPackage = JSON.parse(await readFile(join(root, "apps/mcp-server/package.json"), "utf8"));
const protocolPackage = JSON.parse(await readFile(join(root, "packages/protocol/package.json"), "utf8"));
const version = rootPackage.version;
const staging = join(releaseRoot, `.staging-${process.pid}`);
const bundleName = `browser-agent-mcp-${version}`;
const extensionArchiveName = `browser-agent-mcp-extension-${version}.zip`;
const productArchiveName = `${bundleName}.zip`;

await mkdir(releaseRoot, { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

try {
  const bundle = join(staging, bundleName);
  const extensionDir = join(bundle, "extension");
  const serverDir = join(bundle, "mcp-server");
  await Promise.all([
    mkdir(extensionDir, { recursive: true }),
    mkdir(serverDir, { recursive: true })
  ]);
  await cp(join(root, "apps/extension/.output/chrome-mv3"), extensionDir, { recursive: true });
  await cp(join(root, "apps/mcp-server/dist"), join(serverDir, "dist"), { recursive: true });
  await cp(join(root, "apps/mcp-server/scripts/setup.mjs"), join(serverDir, "setup.mjs"));
  await cp(join(root, "apps/mcp-server/scripts/host-config.mjs"), join(serverDir, "host-config.mjs"));
  await cp(join(root, "setup-mcp.command"), join(bundle, "setup-mcp.command"));
  await cp(join(root, "setup-mcp.bat"), join(bundle, "setup-mcp.bat"));

  const runtimePackage = {
    name: serverPackage.name,
    version,
    private: true,
    type: "module",
    engines: serverPackage.engines,
    dependencies: {
      "@modelcontextprotocol/sdk": serverPackage.dependencies["@modelcontextprotocol/sdk"],
      "jsonc-parser": serverPackage.dependencies["jsonc-parser"],
      ws: serverPackage.dependencies.ws,
      zod: serverPackage.dependencies.zod
    }
  };
  await writeFile(join(serverDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  const install = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: serverDir,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(`Could not install packaged MCP Server dependencies (exit ${install.status}).`);

  const protocolNodeDir = join(serverDir, "node_modules/@browser-agent-mcp/protocol");
  await mkdir(protocolNodeDir, { recursive: true });
  await cp(join(root, "packages/protocol/dist"), join(protocolNodeDir, "dist"), { recursive: true });
  const runtimeProtocol = {
    name: protocolPackage.name,
    version,
    main: protocolPackage.main,
    type: "module",
    types: protocolPackage.types,
    exports: protocolPackage.exports
  };
  await writeFile(join(protocolNodeDir, "package.json"), `${JSON.stringify(runtimeProtocol, null, 2)}\n`);

  await cp(join(root, "INSTALL.md"), join(bundle, "INSTALL.md"));
  await cp(join(root, "FIRST-RUN.md"), join(bundle, "FIRST-RUN.md"));
  await cp(join(root, "FIRST-RUN.md"), join(releaseRoot, `FIRST-RUN-${version}.md`));
  await createZip(extensionDir, join(releaseRoot, extensionArchiveName), "extension");
  await createZip(bundle, join(releaseRoot, productArchiveName), bundleName);
  process.stdout.write(`Chrome/Edge extension package: ${join(releaseRoot, extensionArchiveName)}\n`);
  process.stdout.write(`Complete product package: ${join(releaseRoot, productArchiveName)}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function createZip(sourceDir, destination, archiveRoot) {
  const temporary = `${destination}.tmp`;
  await rm(temporary, { force: true });
  const files = {};
  await addFiles(sourceDir, archiveRoot, files);
  await writeFile(temporary, zipSync(files, { level: 9 }));
  await rename(temporary, destination);
}

async function addFiles(directory, archivePath, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    const relativePath = `${archivePath}/${entry.name}`;
    if (entry.isDirectory()) await addFiles(fullPath, relativePath, files);
    else if (entry.isFile()) {
      const data = await readFile(fullPath);
      files[relativePath] = relativePath.endsWith(".command")
        ? [data, { os: 3, attrs: (0o100755 << 16) >>> 0 }]
        : data;
    }
  }
}
