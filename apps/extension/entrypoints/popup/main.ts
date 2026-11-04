import "./style.css";
import type { SitePermission } from "@browser-agent-mcp/protocol";
import { hostPermissionPattern, isSitePermission, parseExactOrigin } from "@browser-agent-mcp/protocol/policy.js";
import { initializeLanguage, saveLanguage, t, translateAuditValue } from "../shared/i18n";

type PopupState = {
  origin: string | null;
  site: SitePermission | undefined;
  hostPermission: boolean;
  paused: boolean;
};

type ConfirmationData = {
  requestId: string;
  origin: string;
  action: string;
  target: string;
  value?: string;
  allowAllAvailable?: boolean;
  createdAt: number;
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};

const notice = byId<HTMLDivElement>("notice");
let currentState: PopupState = { origin: null, site: undefined, hostPermission: false, paused: false };
let pendingConfirmation: ConfirmationData | undefined;

function showNotice(message: string, isError = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
}

function runUiAction(action: () => Promise<void>): void {
  void action().catch((error: unknown) =>
    showNotice(error instanceof Error ? error.message : t("popup.actionFailed"), true)
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
  const session = await chrome.storage.session.get(null);
  pendingConfirmation = Object.entries(session)
    .filter(([key, value]) => key.startsWith("confirmation:") && isConfirmationData(value))
    .map(([, value]) => value)
    .filter((value) => Date.now() - value.createdAt <= 60_000)
    .sort((left, right) => left.createdAt - right.createdAt)[0];
  if (pendingConfirmation) {
    renderConfirmation(pendingConfirmation);
    return;
  }
  byId("confirmation-card").hidden = true;
  byId("current-card").hidden = false;
  byId("pause-button").hidden = false;
  byId("popup-footer").hidden = false;
  byId("setup-link").hidden = false;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const origin = originFromTabUrl(tab?.url);
  const stored = await chrome.storage.local.get(["connectionStatus", "sites", "paused", "uiLanguage"]);
  byId<HTMLSelectElement>("ui-language").value = stored.uiLanguage === "zh-CN" || (!stored.uiLanguage && document.documentElement.lang === "zh-CN")
    ? "zh-CN"
    : "en";
  const sites = Array.isArray(stored.sites) ? stored.sites.filter(isSitePermission) : [];
  const site = origin ? sites.find((item) => item.origin === origin) : undefined;
  const hostPermission = origin
    ? await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] })
    : false;
  currentState = { origin, site, hostPermission, paused: stored.paused === true };

  byId("current-origin").textContent = origin ?? t("popup.unavailable");
  byId("current-origin").title = origin ?? "";
  byId("site-status").textContent = getSiteStatus(site, hostPermission);
  byId("site-status").className = `site-status${site && hostPermission && !currentState.paused ? ` ${site.mode}` : ""}`;

  const siteAction = byId<HTMLButtonElement>("site-action");
  siteAction.hidden = !origin || Boolean(site && hostPermission);
  siteAction.disabled = !origin || currentState.paused;
  siteAction.textContent = site ? t("popup.restoreSite") : t("popup.allowReadonly");

  const modeButton = byId<HTMLButtonElement>("mode-action");
  modeButton.hidden = !site || !hostPermission;
  modeButton.disabled = currentState.paused;
  modeButton.textContent = site?.mode === "interact" ? t("popup.switchReadonly") : t("popup.enableInteraction");

  const allowActionsRow = byId<HTMLLabelElement>("allow-actions-row");
  allowActionsRow.hidden = !site || !hostPermission || site.mode !== "interact";
  const allowActionsToggle = byId<HTMLInputElement>("allow-all-actions");
  allowActionsToggle.checked = site?.mode === "interact" && site.allowAllActions === true;
  allowActionsToggle.disabled = currentState.paused;

  const fillRow = byId<HTMLLabelElement>("fill-row");
  fillRow.hidden = !site || !hostPermission || site.mode !== "interact";
  const fillToggle = byId<HTMLInputElement>("allow-search-fill");
  fillToggle.checked = site?.mode === "interact" && site.allowFill;
  fillToggle.disabled = currentState.paused;

  const revoke = byId<HTMLButtonElement>("revoke-site");
  revoke.hidden = !site;
  revoke.disabled = currentState.paused;

  const pause = byId<HTMLButtonElement>("pause-button");
  pause.textContent = currentState.paused ? t("popup.resume") : t("popup.pauseAll");
  pause.classList.toggle("paused", currentState.paused);
  byId("current-card").classList.toggle("is-paused", currentState.paused);

  const connection = byId<HTMLDivElement>("connection");
  const connected = stored.connectionStatus === "connected";
  const notConfigured = stored.connectionStatus === "not-configured";
  byId("connection-label").textContent = connected
    ? t("popup.connected")
    : notConfigured ? t("popup.finishSetup") : t("popup.disconnected");
  connection.classList.toggle("connected", connected);
  connection.classList.toggle("error", !connected && !notConfigured);
  byId("setup-link").textContent = notConfigured ? t("popup.setup") : t("popup.settings");

  byId("site-count").textContent = sites.length === 1
    ? t("popup.siteConfigured")
    : t("popup.sitesConfigured", { count: sites.length });
}

function isConfirmationData(value: unknown): value is ConfirmationData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConfirmationData>;
  return typeof candidate.requestId === "string" &&
    typeof candidate.origin === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.target === "string" &&
    typeof candidate.createdAt === "number" &&
    (candidate.value === undefined || typeof candidate.value === "string") &&
    (candidate.allowAllAvailable === undefined || typeof candidate.allowAllAvailable === "boolean");
}

function renderConfirmation(data: ConfirmationData): void {
  byId("confirmation-card").hidden = false;
  byId("current-card").hidden = true;
  byId("pause-button").hidden = true;
  byId("popup-footer").hidden = true;
  byId("setup-link").hidden = true;
  byId("confirm-origin").textContent = data.origin;
  byId("confirm-action").textContent = translateAuditValue(data.action);
  byId("confirm-target").textContent = data.target;
  byId<HTMLDivElement>("confirm-value-row").hidden = typeof data.value !== "string";
  byId("confirm-value").textContent = data.value ?? "";
  byId<HTMLButtonElement>("confirm-all").hidden = data.allowAllAvailable === false;
  byId<HTMLParagraphElement>("confirmation-error").hidden = true;
  for (const id of ["confirm-deny", "confirm-once", "confirm-all"]) {
    byId<HTMLButtonElement>(id).disabled = false;
  }
}

async function resolveConfirmation(approved: boolean, allowAll = false): Promise<void> {
  const confirmation = pendingConfirmation;
  if (!confirmation) return;
  for (const id of ["confirm-deny", "confirm-once", "confirm-all"]) {
    byId<HTMLButtonElement>(id).disabled = true;
  }
  try {
    const result = await chrome.runtime.sendMessage({
      type: "confirm:resolve",
      requestId: confirmation.requestId,
      approved,
      allowAll
    });
    if (!result?.ok) {
      const error = byId<HTMLParagraphElement>("confirmation-error");
      error.textContent = result?.error ?? t("confirm.expired");
      error.hidden = false;
      for (const id of ["confirm-deny", "confirm-once", "confirm-all"]) {
        byId<HTMLButtonElement>(id).disabled = false;
      }
      return;
    }
    window.close();
  } catch (error) {
    const message = byId<HTMLParagraphElement>("confirmation-error");
    message.textContent = error instanceof Error ? error.message : t("confirm.sendFailed");
    message.hidden = false;
    for (const id of ["confirm-deny", "confirm-once", "confirm-all"]) {
      byId<HTMLButtonElement>(id).disabled = false;
    }
  }
}

function getSiteStatus(site: SitePermission | undefined, hostPermission: boolean): string {
  if (!currentState.origin) return t("popup.unsupported");
  if (!site) return t("popup.notAuthorized");
  if (!hostPermission) return t("popup.restorePermission");
  if (currentState.paused) return t("popup.paused");
  return site.mode === "interact" ? t("popup.interactionAllowed") : t("popup.readonlyAccess");
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
    if (!origin) throw new Error(t("popup.httpOnly"));
    const pattern = hostPermissionPattern(origin);
    if (!await chrome.permissions.request({ origins: [pattern] })) {
      throw new Error(t("popup.permissionDenied"));
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
    if (!origin || !site) throw new Error(t("popup.authorizeFirst"));
    const next: SitePermission = {
      ...site,
      mode: site.mode === "interact" ? "readonly" : "interact",
      allowFill: false,
      allowAllActions: site.mode === "interact" ? false : site.allowAllActions
    };
    await updateSite(origin, next, next.mode);
  });
});

byId<HTMLInputElement>("allow-all-actions").addEventListener("change", (event) => {
  runUiAction(async () => {
    const { origin, site } = currentState;
    if (!origin || !site || site.mode !== "interact") {
      throw new Error(t("popup.authorizeFirst"));
    }
    const allowAllActions = (event.currentTarget as HTMLInputElement).checked;
    await updateSite(origin, { ...site, allowAllActions }, allowAllActions ? "allow-all-actions" : "confirm-each-action");
  });
});

byId<HTMLInputElement>("allow-search-fill").addEventListener("change", (event) => {
  runUiAction(async () => {
    const { origin, site } = currentState;
    if (!origin || !site || site.mode !== "interact") {
      throw new Error(t("popup.enableInteractionFirst"));
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

byId<HTMLSelectElement>("ui-language").addEventListener("change", (event) => {
  const language = (event.currentTarget as HTMLSelectElement).value;
  runUiAction(async () => saveLanguage(language === "zh-CN" ? "zh-CN" : "en"));
});

byId<HTMLButtonElement>("confirm-deny").addEventListener("click", () => void resolveConfirmation(false));
byId<HTMLButtonElement>("confirm-once").addEventListener("click", () => void resolveConfirmation(true));
byId<HTMLButtonElement>("confirm-all").addEventListener("click", () => void resolveConfirmation(true, true));

chrome.storage.onChanged.addListener(() => {
  void render().catch((error: unknown) =>
    showNotice(error instanceof Error ? error.message : t("popup.refreshFailed"), true)
  );
});
void initializeLanguage()
  .then(render)
  .catch((error: unknown) => showNotice(error instanceof Error ? error.message : t("popup.loadFailed"), true));
