# Browser Agent MCP：构建后从这里开始

> **先选完整产品包** `browser-agent-mcp-<版本>.zip`。仅有扩展的 `browser-agent-mcp-extension-<版本>.zip` 不包含 MCP Server，不能单独完成配对。

## 第一次安装

1. 解压完整产品包，打开 Chrome 或 Edge 的扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 打开“开发者模式”，点“加载已解压的扩展程序”，选择刚解压目录里的 `extension` 文件夹。
3. 在扩展管理页找到 **Browser Agent MCP**，复制它显示的扩展 ID（32 个字符）。
4. 在解压目录运行配对向导：
   - **macOS**：双击 `setup-mcp.command`。如果系统不允许双击打开，右键选择“打开”，或在终端运行 `bash setup-mcp.command`。
   - **Windows**：双击 `setup-mcp.bat`。
   - 首次配置时粘贴刚才复制的扩展 ID。再次运行时，向导会优先从已有配置检测扩展 ID；如检测到当前扩展，按回车即可沿用 ID 和配对密钥，并原位更新 Host 启动配置。首次配置时选择一个或多个 MCP Host。修改前会备份现有配置；遇到属于其他扩展的同名服务时会先询问是否替换。向导会显示需粘贴到扩展设置的 **Pairing token**。

5. 向导支持 Visual Studio Code、Cursor 和 Claude Desktop。选择完成后，按提示重启或重新加载所选 MCP Host；MCP Host 会启动本机 Browser Agent MCP 服务。macOS/Windows 双击向导还会尝试把 Browser Agent Skill 安装到 Codex 用户目录；如已存在同名 Skill，会保留原文件。
6. 点击浏览器工具栏的扩展图标，打开 **Settings / 设置**，将向导显示的 Pairing token / 配对密钥粘贴进去并保存。连接状态显示已连接后，回到要操作的网站，再点扩展图标并授权该网站（建议先保持只读）。
7. 重启 Codex 使其加载新 Skill。然后在 Codex 中要求“读取当前浏览器页面”，并确认可用工具中出现 `browser_tabs_list` / `browser_page_inspect`。

> **重要：配对向导会自动写入所选 Host 的全局配置，但不会擅自重启 Host。** 保存密钥后，仍需按提示重启或重新加载所选 Host，扩展才能显示“已连接”。

Skill 目前自动安装到 Codex（`~/.codex/skills/browser-agent-mcp/SKILL.md`）。其他 MCP 客户端仍可使用浏览器工具，但 Skill 的安装方式需遵循各客户端自己的能力；不要把 Skill 安装成功当成 MCP 工具已连接。

### 仍显示未连接？

- 确认向导中选择了正确的 MCP Host，并已按提示重启或重新加载它。
- 扩展设置中的配对密钥必须与该配置里的 `BROWSER_AGENT_TOKEN` 完全一致。
- 扩展端口和 MCP 配置里的 `BROWSER_AGENT_PORT` 必须一致（默认 `38741`）。
- 修改 Host 配置后，重新启动 Server；修改扩展配对密钥后，扩展会自动重连。

## 已经装好扩展，只想找密钥

在**解压后的完整产品目录**重新运行对应系统的配对向导。扩展 ID 可在 `chrome://extensions` 或 `edge://extensions` 的 Browser Agent MCP 卡片中找到。

如果提示配置文件已存在，不要删除或覆盖它：打开现有 `mcp-config.json`，复制 `BROWSER_AGENT_TOKEN` 即可。也可以在扩展设置里重新粘贴该值。

## 日常使用

MCP Host 会按需启动本机 MCP Server，不需要单独常驻启动服务。确认 MCP Host 中的 Browser Agent MCP 已启用、浏览器扩展显示已连接、当前网站已授权后，就可以让 Agent 使用 `browser_*` 工具。需要确认时会优先使用扩展弹窗；你可以选择仅允许本次操作，或允许该网站上的所有常规操作。表单提交、高影响操作和跨站导航仍会逐次确认。

详细说明见同目录的 [`INSTALL.md`](./INSTALL.md)。
