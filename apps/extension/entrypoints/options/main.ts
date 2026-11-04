import "./style.css";
import type { SitePermission } from "@browser-agent-mcp/protocol";
import { hostPermissionPattern, isSitePermission, parseExactOrigin } from "@browser-agent-mcp/protocol/policy.js";
import { initializeLanguage, saveLanguage, t, translateAuditValue } from "../shared/i18n";

type AuditEntry = { at: number; origin: string; action: string; result: string };
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing settings element: ${id}`);
  return element as T;
};

const notice = byId<HTMLDivElement>("notice");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let screenshotEnabled = false;

function showNotice(message: string, isError = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.classList.add("visible");
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove("visible"), 5000);
}

function exactOrigin(input: string): string {
  const origin = parseExactOrigin(input);
  if (!origin) throw new Error(t("error.origin"));
  return origin;
}

function translatedError(error: unknown): string {
  if (!(error instanceof Error)) return t("error.actionFailed");
  const knownErrors: Record<string, Parameters<typeof t>[0]> = {
    "The settings action failed.": "error.actionFailed",
    "Enter only an HTTP(S) origin, for example https://example.com (no path, credentials, query, or fragment).": "error.origin",
    "The pairing token must be at least 32 characters.": "error.tokenShort",
    "The bridge port must be between 1024 and 65535.": "error.port",
    "Site access was not granted. No website data was added.": "error.sitePermission"
  };
  return knownErrors[error.message] ? t(knownErrors[error.message]) : error.message;
}

function runUiAction(action: () => Promise<void>): void {
  void action().catch((error: unknown) =>
    showNotice(translatedError(error), true)
  );
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(["pairingToken", "bridgePort", "connectionStatus", "sites", "paused", "auditLog", "uiLanguage"]);
  byId<HTMLSelectElement>("ui-language").value = stored.uiLanguage === "zh-CN" || (!stored.uiLanguage && document.documentElement.lang === "zh-CN")
    ? "zh-CN"
    : "en";
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
    label.textContent = t("settings.connected");
  } else if (status === "not-configured") {
    label.textContent = t("settings.notPaired");
  } else {
    dot.classList.add("error");
    label.textContent = t("settings.disconnected");
  }
}

function renderPause(paused: boolean): void {
  const button = byId<HTMLButtonElement>("pause-button");
  button.textContent = paused ? t("settings.resume") : t("settings.pause");
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
    empty.textContent = t("settings.noSites");
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
    mode.textContent = site.mode === "interact" ? t("settings.interactionBadge") : t("settings.readonlyBadge");

    const modeButton = document.createElement("button");
    modeButton.className = "text-button";
    modeButton.type = "button";
    modeButton.textContent = site.mode === "interact" ? t("settings.setReadonly") : t("settings.enableInteraction");
    modeButton.addEventListener("click", () => runUiAction(() => updateSite(site, {
      ...site,
      mode: site.mode === "interact" ? "readonly" : "interact",
      allowFill: false,
      allowAllActions: site.mode === "interact" ? false : site.allowAllActions
    })));

    const fillButton = document.createElement("button");
    fillButton.className = "text-button fill-toggle";
    fillButton.type = "button";
    fillButton.textContent = site.mode === "interact" && site.allowFill ? t("settings.searchFillAllowed") : t("settings.allowSearchFill");
    fillButton.title = t("settings.searchFillTitle");
    fillButton.disabled = site.mode !== "interact";
    fillButton.addEventListener("click", () => runUiAction(() => updateSite(site, { ...site, allowFill: !site.allowFill })));

    const confirmationButton = document.createElement("button");
    confirmationButton.className = "text-button confirm-toggle";
    confirmationButton.type = "button";
    confirmationButton.textContent = site.allowAllActions ? t("settings.confirmEachAction") : t("settings.allowAllActions");
    confirmationButton.title = t("settings.allowAllActionsTitle");
    confirmationButton.disabled = site.mode !== "interact";
    confirmationButton.addEventListener("click", () => runUiAction(() =>
      updateSite(site, { ...site, allowAllActions: !site.allowAllActions })
    ));

    const removeButton = document.createElement("button");
    removeButton.className = "text-button remove-site";
    removeButton.type = "button";
    removeButton.textContent = t("settings.revoke");
    removeButton.addEventListener("click", () => runUiAction(() => removeSite(site)));

    row.append(origin, mode, modeButton, fillButton, confirmationButton, removeButton);
    list.append(row);
  }
}

async function updateSite(previous: SitePermission, next: SitePermission): Promise<void> {
  const stored = await chrome.storage.local.get("sites");
  const sites = (Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [])
    .map((site) => site.origin === previous.origin ? next : site);
  await chrome.storage.local.set({ sites });
  const auditResult = next.mode === "readonly"
    ? "read-only"
    : next.allowAllActions
      ? "allow-all-actions"
      : next.allowFill ? "interact+search-fill" : "interact";
  await appendAudit(next.origin, "Update site policy", auditResult);
  showNotice(t("settings.siteUpdated", { origin: next.origin }));
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
  showNotice(t("settings.siteRevoked", { origin: site.origin }));
  await load();
}

async function renderScreenshotPermission(): Promise<void> {
  const enabled = await chrome.permissions.contains({ permissions: ["tabs"] });
  screenshotEnabled = enabled;
  byId("screenshot-description").textContent = enabled
    ? t("settings.screenshotGranted")
    : t("settings.screenshotDenied");
  byId<HTMLButtonElement>("screenshot-button").textContent = enabled ? t("settings.disableScreenshots") : t("settings.enableScreenshots");
}

function renderAudit(entries: AuditEntry[]): void {
  const list = byId<HTMLDivElement>("audit-list");
  list.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("settings.noActivity");
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
    action.textContent = translateAuditValue(entry.action);
    const result = document.createElement("span");
    result.className = `audit-result ${entry.result}`;
    result.textContent = translateAuditValue(entry.result);
    const time = document.createElement("span");
    time.className = "audit-time";
    time.textContent = new Date(entry.at).toLocaleString(document.documentElement.lang);
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
    if (token.length < 32) throw new Error(t("error.tokenShort"));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(t("error.port"));
    await chrome.storage.local.set({ pairingToken: token, bridgePort: port });
    showNotice(t("notice.connectionSaved"));
    await load();
  });
});

byId<HTMLButtonElement>("toggle-token").addEventListener("click", () => {
  const input = byId<HTMLInputElement>("pairing-token");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  byId("toggle-token").textContent = visible ? t("settings.show") : t("settings.hide");
});

byId<HTMLFormElement>("site-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runUiAction(async () => {
    const origin = exactOrigin(byId<HTMLInputElement>("site-origin").value);
    const mode = byId<HTMLSelectElement>("site-mode").value === "interact" ? "interact" : "readonly";
    const pattern = hostPermissionPattern(origin);
    if (!await chrome.permissions.request({ origins: [pattern] })) {
      throw new Error(t("error.sitePermission"));
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
    showNotice(t(mode === "readonly" ? "notice.siteAddedReadonly" : "notice.siteAddedInteract", { origin }));
    await load();
  });
});

byId<HTMLButtonElement>("pause-button").addEventListener("click", () => {
  runUiAction(async () => {
    const stored = await chrome.storage.local.get("paused");
    const paused = stored.paused !== true;
    await chrome.storage.local.set({ paused });
    showNotice(paused ? t("notice.accessPaused") : t("notice.accessResumed"));
    await load();
  });
});

byId<HTMLButtonElement>("screenshot-button").addEventListener("click", () => {
  runUiAction(async () => {
    if (screenshotEnabled) {
      await chrome.permissions.remove({ permissions: ["tabs"] });
      showNotice(t("notice.screenshotDisabled"));
    } else if (await chrome.permissions.request({ permissions: ["tabs"] })) {
      showNotice(t("notice.screenshotEnabled"));
    } else {
      showNotice(t("notice.screenshotDenied"), true);
    }
    await load();
  });
});

byId<HTMLButtonElement>("clear-audit").addEventListener("click", () => {
  runUiAction(async () => {
    await chrome.storage.local.set({ auditLog: [] });
    showNotice(t("notice.historyCleared"));
    await load();
  });
});

chrome.storage.onChanged.addListener(() => void load());
byId<HTMLSelectElement>("ui-language").addEventListener("change", (event) => {
  const language = (event.currentTarget as HTMLSelectElement).value;
  runUiAction(async () => saveLanguage(language === "zh-CN" ? "zh-CN" : "en"));
});
void initializeLanguage()
  .then(load)
  .catch((error: unknown) => showNotice(error instanceof Error ? error.message : t("notice.couldNotLoad"), true));
