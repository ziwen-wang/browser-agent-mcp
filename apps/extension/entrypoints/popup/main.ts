import "./style.css";
import type { SitePermission } from "@browser-agent-mcp/protocol";
import { hostPermissionPattern, isSitePermission, parseExactOrigin } from "@browser-agent-mcp/protocol/policy.js";

type PopupState = {
  origin: string | null;
  site: SitePermission | undefined;
  hostPermission: boolean;
  paused: boolean;
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};

const notice = byId<HTMLDivElement>("notice");
let currentState: PopupState = { origin: null, site: undefined, hostPermission: false, paused: false };

function showNotice(message: string, isError = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
}

function runUiAction(action: () => Promise<void>): void {
  void action().catch((error: unknown) =>
    showNotice(error instanceof Error ? error.message : "The action could not be completed.", true)
  );
}

function originFromTabUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return parseExactOrigin(new URL(value).origin);
  } catch {
    return null;
  }
}

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const origin = originFromTabUrl(tab?.url);
  const stored = await chrome.storage.local.get(["connectionStatus", "sites", "paused"]);
  const sites = Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [];
  const site = origin ? sites.find((item) => item.origin === origin) : undefined;
  const hostPermission = origin
    ? await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] })
    : false;
  currentState = { origin, site, hostPermission, paused: stored.paused === true };

  byId("current-origin").textContent = origin ?? "This page is not available to the agent";
  byId("current-origin").title = origin ?? "";
  byId("site-status").textContent = getSiteStatus(site, hostPermission);
  byId("site-status").className = `site-status${site && hostPermission && !currentState.paused ? ` ${site.mode}` : ""}`;

  const siteAction = byId<HTMLButtonElement>("site-action");
  siteAction.hidden = !origin || Boolean(site && hostPermission);
  siteAction.disabled = !origin || currentState.paused;
  siteAction.textContent = site ? "Restore site permission" : "Allow read-only access";

  const modeButton = byId<HTMLButtonElement>("mode-action");
  modeButton.hidden = !site || !hostPermission;
  modeButton.disabled = currentState.paused;
  modeButton.textContent = site?.mode === "interact" ? "Switch to read-only" : "Enable interaction";

  const fillRow = byId<HTMLLabelElement>("fill-row");
  fillRow.hidden = !site || !hostPermission || site.mode !== "interact";
  const fillToggle = byId<HTMLInputElement>("allow-search-fill");
  fillToggle.checked = site?.mode === "interact" && site.allowFill;
  fillToggle.disabled = currentState.paused;

  const revoke = byId<HTMLButtonElement>("revoke-site");
  revoke.hidden = !site;
  revoke.disabled = currentState.paused;

  const pause = byId<HTMLButtonElement>("pause-button");
  pause.textContent = currentState.paused ? "Resume agent access" : "Pause all agent access";
  pause.classList.toggle("paused", currentState.paused);
  byId("current-card").classList.toggle("is-paused", currentState.paused);

  const connection = byId<HTMLDivElement>("connection");
  const connected = stored.connectionStatus === "connected";
  const notConfigured = stored.connectionStatus === "not-configured";
  byId("connection-label").textContent = connected
    ? "MCP server connected"
    : notConfigured ? "Finish pairing in settings" : "MCP server disconnected";
  connection.classList.toggle("connected", connected);
  connection.classList.toggle("error", !connected && !notConfigured);
  byId("setup-link").textContent = notConfigured ? "Set up" : "Settings";

  byId("site-count").textContent = `${sites.length} ${sites.length === 1 ? "site" : "sites"} configured`;
}

function getSiteStatus(site: SitePermission | undefined, hostPermission: boolean): string {
  if (!currentState.origin) return "Unsupported browser page";
  if (!site) return "Not authorized";
  if (!hostPermission) return "Browser permission needs restoring";
  if (currentState.paused) return "Agent access paused";
  return site.mode === "interact" ? "Interaction allowed" : "Read-only access";
}

async function appendAudit(origin: string, action: string, result: string): Promise<void> {
  const stored = await chrome.storage.local.get("auditLog");
  const entries = Array.isArray(stored.auditLog) ? stored.auditLog : [];
  entries.unshift({ at: Date.now(), origin, action, result });
  await chrome.storage.local.set({ auditLog: entries.slice(0, 50) });
}

byId<HTMLButtonElement>("site-action").addEventListener("click", () => {
  runUiAction(async () => {
    const { origin, site } = currentState;
    if (!origin) throw new Error("Only HTTP(S) websites can be authorized.");
    const pattern = hostPermissionPattern(origin);
    if (!await chrome.permissions.request({ origins: [pattern] })) {
      throw new Error("Browser permission was not granted. This site remains inaccessible.");
    }

    if (!site) {
      const stored = await chrome.storage.local.get("sites");
      const sites = Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [];
      sites.push({ origin, mode: "readonly", allowFill: false });
      await chrome.storage.local.set({ sites });
      await appendAudit(origin, "Configure site access", "readonly");
    }
    await render();
  });
});

byId<HTMLButtonElement>("mode-action").addEventListener("click", () => {
  runUiAction(async () => {
    const { origin, site } = currentState;
    if (!origin || !site) throw new Error("Authorize this site before changing its access mode.");
    const next: SitePermission = {
      ...site,
      mode: site.mode === "interact" ? "readonly" : "interact",
      allowFill: false
    };
    await updateSite(origin, next, next.mode);
  });
});

byId<HTMLInputElement>("allow-search-fill").addEventListener("change", (event) => {
  runUiAction(async () => {
    const { origin, site } = currentState;
    if (!origin || !site || site.mode !== "interact") {
      throw new Error("Enable interaction for this site before changing search autofill.");
    }
    const allowFill = (event.currentTarget as HTMLInputElement).checked;
    await updateSite(origin, { ...site, allowFill }, allowFill ? "interact+search-fill" : "interact");
  });
});

async function updateSite(origin: string, next: SitePermission, auditResult: string): Promise<void> {
  const stored = await chrome.storage.local.get("sites");
  const sites = (Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [])
    .map((site) => site.origin === origin ? next : site);
  await chrome.storage.local.set({ sites });
  await appendAudit(origin, "Update site policy", auditResult);
  await render();
}

byId<HTMLButtonElement>("revoke-site").addEventListener("click", () => {
  runUiAction(async () => {
    const { origin, site } = currentState;
    if (!origin || !site) return;
    const stored = await chrome.storage.local.get("sites");
    const sites = (Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [])
      .filter((item) => item.origin !== origin);
    const pattern = hostPermissionPattern(origin);
    if (!sites.some((item) => hostPermissionPattern(item.origin) === pattern)) {
      await chrome.permissions.remove({ origins: [pattern] });
    }
    await chrome.storage.local.set({ sites });
    await appendAudit(origin, "Revoke site access", "revoked");
    await render();
  });
});

byId<HTMLButtonElement>("pause-button").addEventListener("click", () => {
  runUiAction(async () => {
    await chrome.storage.local.set({ paused: !currentState.paused });
    await render();
  });
});

byId<HTMLButtonElement>("setup-link").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener(() => {
  void render().catch((error: unknown) =>
    showNotice(error instanceof Error ? error.message : "Could not refresh extension status.", true)
  );
});
void render().catch((error: unknown) =>
  showNotice(error instanceof Error ? error.message : "Could not load the current website.", true)
);
