# Browser Agent MCP

让 MCP Agent 操作用户**当前正在使用的 Chromium 浏览器**，复用现有登录态。项目由 Chrome/Edge MV3 扩展和本机 MCP Server 组成：DOM 是默认交互方式，截图是显式启用后的按需补充。

> 当前版本支持 Chrome 116+ 和 Chromium 内核的 Edge。数据通过本机回环 WebSocket 桥接；不会启动另一套浏览器。

## 安全默认值

- 扩展弹窗是日常控制入口：用户在当前网页打开弹窗后，按完整 origin（协议、主机、端口）授权当前站点；新安装时没有任何站点权限，默认只读。
- 每个站点默认只读。只读仅允许查看当前活动网页的有界 DOM/文本摘要、交互元素和滚动页面。
- 点击、导航、选择下拉项总是打开扩展自己的确认页；普通输入也逐次确认。
- 用户可以按站点允许自动填写，但自动确认范围严格限制为非敏感的 `input[type=search]`。其他字段仍需确认；点击和导航永远不能被白名单跳过。
- 密码、支付卡、验证码、文件等敏感字段不能被读取为控件摘要或填入。敏感字段检测使用启发式规则，不能代替用户审查。
- 截图需要单独授予浏览器 `tabs` 权限，且只能捕获已授权站点的可见活动标签页。
- 一键暂停会拒绝所有 MCP 浏览器请求；弹窗可暂停当前 Agent、调整当前站点模式或撤销访问。完整设置页用于配对 MCP Server、管理站点与审计记录。
- 扩展仅在用户点击工具栏图标打开弹窗时，通过 `activeTab` 临时读取当前标签页地址；不会因此获得持续的网站访问权。逐站授权仍由浏览器的可选主机权限控制。
- MCP Server 只绑定 `127.0.0.1`，要求精确的扩展 Origin 和 256-bit 配对密钥；限制 WebSocket 路径、消息大小、请求速率，不提供任意 JavaScript 执行能力。
- 网页内容始终是不可信数据，不会改变扩展端权限、白名单或确认策略。

浏览器的 host-permission API 不区分端口。扩展仍会在每次操作时按完整 origin 检查站点策略，因此同一主机不同端口的策略彼此独立；浏览器权限提示本身可能显示该主机的较宽权限范围。

## 项目结构

```text
apps/
  extension/       WXT + TypeScript，MV3 弹窗主入口、设置、授权、确认与网页操作
  mcp-server/      TypeScript MCP stdio Server + 本机 WebSocket 桥
packages/
  protocol/        共享消息类型、站点权限策略和策略测试
```

## 开发与构建

需要 Node.js 22+、npm 10+。

```sh
npm install
npm run typecheck
npm test
npm run build
```

扩展产物位于 `apps/extension/.output/chrome-mv3`。在 Chrome 打开 `chrome://extensions`，启用“开发者模式”，选择“加载已解压的扩展程序”并选择该目录。Edge 可在 `edge://extensions` 执行相同操作。

## 配置 MCP

1. 在 `chrome://extensions`（或 `edge://extensions`）复制扩展 ID。
2. 生成一次性配对密钥：

   ```sh
   npm run generate-token --workspace @browser-agent-mcp/mcp-server
   ```

   将输出保存在密码管理器或本地 MCP 配置中；不要提交到 Git。
3. 复制 `.vscode/mcp.json.example` 为 `.vscode/mcp.json`，填入生成的密钥和 `chrome-extension://<扩展ID>`。本仓库已忽略本地 `mcp.json`。
4. 点击浏览器工具栏中的扩展图标，在“设置”页粘贴相同密钥，确认端口为 `38741` 并保存。弹窗显示 MCP Server 已连接后即可使用。
5. 打开目标网页并点击扩展图标，在弹窗中为当前网站授予“只读访问”。确有需要时，在同一弹窗单独启用“交互”；点击、导航等网页动作仍需逐次确认。完整设置页保留站点总览、截图权限和本地审计记录。

示例 MCP 配置：

```json
{
  "servers": {
    "browser-agent": {
      "type": "stdio",
      "command": "node",
      "args": ["/绝对路径/browser-agent-mcp/apps/mcp-server/dist/index.js"],
      "env": {
        "BROWSER_AGENT_TOKEN": "替换为本机生成的64位十六进制密钥",
        "BROWSER_AGENT_EXTENSION_ORIGIN": "chrome-extension://替换为实际扩展ID",
        "BROWSER_AGENT_PORT": "38741"
      }
    }
  }
}
```

MCP 客户端需要先按正常流程运行 `npm run build`。MCP 客户端每次启动 Server 时，扩展会连接本机端口；不要同时运行多个使用同一端口的 Server。

## MCP 工具

| 工具 | 功能 | 约束 |
|---|---|---|
| `browser_tabs_list` | 查看活动标签页 | 只返回当前活动页，且该 origin 必须已授权 |
| `browser_page_inspect` | 获取页面文本和交互元素摘要 | 只读；最多 15,000 字符和 200 个元素，不读取输入值 |
| `browser_page_scroll` | 滚动页面 | 单次最多 1,000 像素 |
| `browser_page_click` | 点击最近 inspect 返回的元素 | 交互权限 + 每次确认 + 操作前重新验证节点 |
| `browser_page_fill` | 填文本框或多行输入 | 交互权限；敏感字段拒绝；非白名单输入逐次确认 |
| `browser_page_select` | 选择下拉项 | 交互权限 + 每次确认 |
| `browser_tabs_navigate` | 在当前标签页导航 | 当前和目标 origin 都必须有交互授权；每次确认；仅 HTTP(S) |
| `browser_page_screenshot` | 捕获可见活动标签页 | 单独的 `tabs` 权限；只对已授权 origin 可用 |

页面快照中的 selector 只用于定位，不是稳定的永久 ID；页面变化、目标隐藏或目标属性不匹配时，操作会失败并要求重新 inspect。跨域 iframe、封闭 Shadow DOM、Canvas 内部控件以及浏览器内部页面不在当前版本支持范围内。

## 安全边界

本项目限制了 Agent 可以请求的操作，但不能判断用户最终是否应信任某个网站或输入内容。敏感字段识别是防御性启发式；应用还可能通过自定义控件或输入事件产生额外效果。用户应审查每次确认，避免把高敏感站点加入交互授权，并只在可信 MCP 客户端中配置配对密钥。
