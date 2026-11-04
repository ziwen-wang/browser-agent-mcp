#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required to build this project." >&2
  exit 1
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
fi

if (( node_major >= 22 )); then
  npm run release
else
  echo "Node.js 22+ is required; using a temporary Node.js 22 via npm exec."
  npm exec --yes --package=node@22 -- npm run release
fi

echo
echo "构建完成，产物目录：$repo_root/release"
echo
echo "第一次使用："
echo "  1. 解压 release/browser-agent-mcp-<版本>.zip（完整包，不要选 -extension.zip）。"
echo "  2. 在 chrome://extensions 或 edge://extensions 加载解压包中的 extension 文件夹，复制扩展 ID。"
echo "  3. macOS 双击 setup-mcp.command；Windows 双击 setup-mcp.bat；首次配置时粘贴扩展 ID 并选择 MCP Host。"
echo "     后续运行会自动检测已有扩展 ID，可直接更新现有配置。"
echo "  4. 向导会自动写入所选 Host 的用户级配置并显示配对密钥；重启或重新加载 Host。"
echo "  5. 在扩展 Settings 粘贴密钥，确认连接后授权当前网站。"
echo
echo "详细中文步骤：$repo_root/release/FIRST-RUN-$(node -p 'require("./package.json").version').md"
