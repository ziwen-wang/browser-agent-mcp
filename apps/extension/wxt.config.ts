import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Browser Agent MCP",
    description: "A permission-first bridge between an MCP agent and your current browser.",
    minimum_chrome_version: "116",
    permissions: ["storage", "scripting", "activeTab"],
    optional_permissions: ["tabs"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    action: {
      default_title: "Browser Agent MCP",
      default_popup: "popup.html"
    },
  }
});
