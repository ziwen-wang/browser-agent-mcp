#!/bin/bash
set -euo pipefail

product_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$product_dir"

echo "========================================"
echo " Browser Agent MCP | 配对向导"
echo "========================================"
echo "开始前，请确认已在 Chrome 或 Edge 加载 extension 文件夹。"
echo "扩展 ID 可从 chrome://extensions 或 edge://extensions 复制。"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22 或更高版本后重试。" >&2
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

if ! node mcp-server/setup.mjs; then
  echo
  read -r -p "向导未完成，请先查看上方提示。按回车键关闭窗口..."
  exit 1
fi

echo
echo "正在为 Codex 安装 Browser Agent Skill..."
node mcp-server/install-skill.mjs || echo "Skill 未自动安装；可稍后重试：node mcp-server/install-skill.mjs"

echo
echo "========================================"
echo " 下一步"
echo "========================================"
echo "1. 复制上方配对密钥，粘贴到扩展 Settings / 设置并保存。"
echo "2. 重启或重新加载刚才选择的 MCP Host；Codex 用户也请重启 Codex 加载 Skill。"
echo "3. 回到浏览器，确认扩展显示已连接，并授权当前网站。"
echo
read -r -p "按回车键关闭窗口..."
