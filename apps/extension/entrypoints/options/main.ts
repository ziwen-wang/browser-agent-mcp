import "./style.css";
import type { SitePermission } from "@browser-agent-mcp/protocol";
import { hostPermissionPattern, isSitePermission, parseExactOrigin } from "@browser-agent-mcp/protocol/policy.js";

type AuditEntry = { at: number; origin: string; action: string; result: string };
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing settings element: ${id}`);
  return element as T;
};

const notice = byId<HTMLDivElement>("notice");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function showNotice(message: string, isError = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.classList.add("visible");
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove("visible"), 5000);
}

function exactOrigin(input: string): string {
  const origin = parseExactOrigin(input);
  if (!origin) throw new Error("Enter only an HTTP(S) origin, for example https://example.com (no path, credentials, query, or fragment).");
  return origin;
}

function runUiAction(action: () => Promise<void>): void {
  void action().catch((error: unknown) =>
    showNotice(error instanceof Error ? error.message : "The settings action failed.", true)
  );
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(["pairingToken", "bridgePort", "connectionStatus", "sites", "paused", "auditLog"]);
  const tokenInput = byId<HTMLInputElement>("pairing-token");
  if (document.activeElement !== tokenInput) tokenInput.value = typeof stored.pairingToken === "string" ? stored.pairingToken : "";
  const portInput = byId<HTMLInputElement>("bridge-port");
  if (document.activeElement !== portInput) portInput.value = String(stored.bridgePort ?? 38741);
  renderConnection(stored.connectionStatus);
  renderPause(stored.paused === true);
  await renderSites(Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : []);
  await renderScreenshotPermission();
  renderAudit(Array.isArray(stored.auditLog) ? stored.auditLog as AuditEntry[] : []);
}

function renderConnection(status: unknown): void {
  const dot = byId<HTMLSpanElement>("connection-dot");
  const label = byId<HTMLSpanElement>("connection-label");
  dot.classList.remove("connected", "error");
  if (status === "connected") {
    dot.classList.add("connected");
    label.textContent = "MCP server connected";
  } else if (status === "not-configured") {
    label.textContent = "Pairing not configured";
  } else {
    dot.classList.add("error");
    label.textContent = "MCP server disconnected";
  }
}

function renderPause(paused: boolean): void {
  const button = byId<HTMLButtonElement>("pause-button");
  button.textContent = paused ? "Resume agent access" : "Pause agent access";
  button.classList.toggle("button-danger", !paused);
  button.classList.toggle("button-primary", paused);
  byId("pause-button").closest(".section-card")?.classList.toggle("paused", paused);
}

async function renderSites(sites: SitePermission[]): Promise<void> {
  const list = byId<HTMLDivElement>("sites-list");
  list.replaceChildren();
  if (sites.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No sites added. The agent cannot read or control any website yet.";
    list.append(empty);
    return;
  }

  for (const site of sites) {
    const row = document.createElement("div");
    row.className = "site-row";
    const origin = document.createElement("span");
    origin.className = "site-origin";
    origin.textContent = site.origin;
    origin.title = site.origin;

    const mode = document.createElement("span");
    mode.className = `site-badge${site.mode === "interact" ? " interact" : ""}`;
    mode.textContent = site.mode === "interact" ? "INTERACTION" : "READ-ONLY";

    const modeButton = document.createElement("button");
    modeButton.className = "text-button";
    modeButton.type = "button";
    modeButton.textContent = site.mode === "interact" ? "Set read-only" : "Enable interaction";
    modeButton.addEventListener("click", () => runUiAction(() => updateSite(site, {
      ...site,
      mode: site.mode === "interact" ? "readonly" : "interact",
      allowFill: false
    })));

    const fillButton = document.createElement("button");
    fillButton.className = "text-button fill-toggle";
    fillButton.type = "button";
    fillButton.textContent = site.mode === "interact" && site.allowFill ? "Search fill allowed ✓" : "Allow search fill";
    fillButton.title = "Only search-type fields can be filled without confirmation. Clicks and navigation always require confirmation.";
    fillButton.disabled = site.mode !== "interact";
    fillButton.addEventListener("click", () => runUiAction(() => updateSite(site, { ...site, allowFill: !site.allowFill })));

    const removeButton = document.createElement("button");
    removeButton.className = "text-button remove-site";
    removeButton.type = "button";
    removeButton.textContent = "Revoke";
    removeButton.addEventListener("click", () => runUiAction(() => removeSite(site)));

    row.append(origin, mode, modeButton, fillButton, removeButton);
    list.append(row);
  }
}

async function updateSite(previous: SitePermission, next: SitePermission): Promise<void> {
  const stored = await chrome.storage.local.get("sites");
  const sites = (Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [])
    .map((site) => site.origin === previous.origin ? next : site);
  await chrome.storage.local.set({ sites });
  await appendAudit(next.origin, "Update site policy", next.mode === "readonly" ? "read-only" : next.allowFill ? "interact+search-fill" : "interact");
  showNotice(`${next.origin} access updated.`);
  await load();
}

async function removeSite(site: SitePermission): Promise<void> {
  const stored = await chrome.storage.local.get("sites");
  const sites = (Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [])
    .filter((item) => item.origin !== site.origin);
  const pattern = hostPermissionPattern(site.origin);
  if (!sites.some((item) => hostPermissionPattern(item.origin) === pattern)) {
    await chrome.permissions.remove({ origins: [pattern] });
  }
  await chrome.storage.local.set({ sites });
  await appendAudit(site.origin, "Revoke site access", "revoked");
  showNotice(`Revoked ${site.origin}.`);
  await load();
}

async function renderScreenshotPermission(): Promise<void> {
  const enabled = await chrome.permissions.contains({ permissions: ["tabs"] });
  byId("screenshot-description").textContent = enabled
    ? "Granted. Extension receives browser tab metadata; the agent only receives captures of visible, authorized pages."
    : "Not granted. The agent cannot capture screenshots.";
  byId<HTMLButtonElement>("screenshot-button").textContent = enabled ? "Disable screenshots" : "Enable screenshots";
}

function renderAudit(entries: AuditEntry[]): void {
  const list = byId<HTMLDivElement>("audit-list");
  list.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No recent activity.";
    list.append(empty);
    return;
  }
  for (const entry of entries.slice(0, 50)) {
    if (!entry || typeof entry.origin !== "string" || typeof entry.action !== "string" ||
      typeof entry.result !== "string" || typeof entry.at !== "number") continue;
    const row = document.createElement("div");
    row.className = "audit-row";
    const origin = document.createElement("span");
    origin.textContent = entry.origin;
    origin.title = entry.origin;
    const action = document.createElement("span");
    action.className = "audit-action";
    action.textContent = entry.action;
    const result = document.createElement("span");
    result.className = `audit-result ${entry.result}`;
    result.textContent = entry.result;
    const time = document.createElement("span");
    time.className = "audit-time";
    time.textContent = new Date(entry.at).toLocaleString();
    row.append(origin, action, result, time);
    list.append(row);
  }
}

async function appendAudit(origin: string, action: string, result: string): Promise<void> {
  const stored = await chrome.storage.local.get("auditLog");
  const entries = Array.isArray(stored.auditLog) ? stored.auditLog : [];
  entries.unshift({ at: Date.now(), origin, action, result });
  await chrome.storage.local.set({ auditLog: entries.slice(0, 50) });
}

byId<HTMLFormElement>("connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runUiAction(async () => {
    const token = byId<HTMLInputElement>("pairing-token").value.trim();
    const port = Number(byId<HTMLInputElement>("bridge-port").value);
    if (token.length < 32) throw new Error("The pairing token must be at least 32 characters.");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("The bridge port must be between 1024 and 65535.");
    await chrome.storage.local.set({ pairingToken: token, bridgePort: port });
    showNotice("Connection settings saved. The extension is reconnecting.");
    await load();
  });
});

byId<HTMLButtonElement>("toggle-token").addEventListener("click", () => {
  const input = byId<HTMLInputElement>("pairing-token");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  byId("toggle-token").textContent = visible ? "Show" : "Hide";
});

byId<HTMLFormElement>("site-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runUiAction(async () => {
    const origin = exactOrigin(byId<HTMLInputElement>("site-origin").value);
    const mode = byId<HTMLSelectElement>("site-mode").value === "interact" ? "interact" : "readonly";
    const pattern = hostPermissionPattern(origin);
    if (!await chrome.permissions.request({ origins: [pattern] })) {
      throw new Error("Site access was not granted. No website data was added.");
    }

    const stored = await chrome.storage.local.get("sites");
    const sites = Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [];
    const newSite: SitePermission = { origin, mode, allowFill: false };
    const existing = sites.find((item) => item.origin === origin);
    const updated = existing
      ? sites.map((item) => item.origin === origin ? newSite : item)
      : [...sites, newSite];
    await chrome.storage.local.set({ sites: updated });
    await appendAudit(origin, "Configure site access", mode);
    byId<HTMLInputElement>("site-origin").value = "";
    showNotice(`${origin} added as ${mode === "readonly" ? "read-only" : "interactive"}.`);
    await load();
  });
});

byId<HTMLButtonElement>("pause-button").addEventListener("click", () => {
  runUiAction(async () => {
    const stored = await chrome.storage.local.get("paused");
    const paused = stored.paused !== true;
    await chrome.storage.local.set({ paused });
    showNotice(paused ? "Agent access paused." : "Agent access resumed.");
    await load();
  });
});

byId<HTMLButtonElement>("screenshot-button").addEventListener("click", () => {
  runUiAction(async () => {
    const enabled = byId<HTMLButtonElement>("screenshot-button").textContent === "Disable screenshots";
    if (enabled) {
      await chrome.permissions.remove({ permissions: ["tabs"] });
      showNotice("Screenshot permission disabled.");
    } else if (await chrome.permissions.request({ permissions: ["tabs"] })) {
      showNotice("Screenshot permission granted.");
    } else {
      showNotice("Screenshot permission was not granted.", true);
    }
    await load();
  });
});

byId<HTMLButtonElement>("clear-audit").addEventListener("click", () => {
  runUiAction(async () => {
    await chrome.storage.local.set({ auditLog: [] });
    showNotice("Activity history cleared.");
    await load();
  });
});

chrome.storage.onChanged.addListener(() => void load());
void load().catch((error: unknown) => showNotice(error instanceof Error ? error.message : "Could not load settings.", true));
