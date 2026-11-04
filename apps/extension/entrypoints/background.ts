import { CONFIRMATION_TIMEOUT_MS, type BridgeReply, type ExtensionRequest, type PageSnapshot, type SitePermission } from "@browser-agent-mcp/protocol";
import { hostPermissionPattern, isSitePermission, mayAutoAllowFill } from "@browser-agent-mcp/protocol/policy.js";
import { defineBackground } from "wxt/utils/define-background";

const DEFAULT_PORT = 38741;
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
let isConnecting = false;
let auditQueue: Promise<void> = Promise.resolve();

type Confirmation = {
  resolve: (approved: boolean) => void;
  tabId: number;
};

const confirmations = new Map<string, Confirmation>();

export default defineBackground(() => {
  void connectBridge();
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [requestId, pending] of confirmations) {
      if (pending.tabId === tabId) {
        pending.resolve(false);
        void chrome.storage.session.remove(`confirmation:${requestId}`);
      }
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.pairingToken || changes.bridgePort)) {
      disconnectBridge();
      void connectBridge();
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (isConfirmationMessage(message)) {
      void handleConfirmationMessage(message, sender).then(sendResponse);
      return true;
    }
    return false;
  });
});

async function connectBridge(): Promise<void> {
  if (isConnecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  isConnecting = true;
  const settings = await chrome.storage.local.get(["pairingToken", "bridgePort"]);
  const token = typeof settings.pairingToken === "string" ? settings.pairingToken.trim() : "";
  const port = Number(settings.bridgePort ?? DEFAULT_PORT);

  if (token.length < 32 || !Number.isInteger(port) || port < 1024 || port > 65535) {
    await chrome.storage.local.set({ connectionStatus: "not-configured" });
    isConnecting = false;
    return;
  }

  const bridge = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  socket = bridge;
  const timeout = setTimeout(() => bridge.close(), 5000);

  bridge.addEventListener("open", () => {
    bridge.send(JSON.stringify({ type: "hello", token }));
  }, { once: true });

  bridge.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      bridge.close(1003, "Unexpected binary message.");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      bridge.close(1007, "Invalid JSON.");
      return;
    }

    if (isObject(message) && message.type === "ready") {
      clearTimeout(timeout);
      isConnecting = false;
      void chrome.storage.local.set({ connectionStatus: "connected" });
      startKeepalive(bridge);
      return;
    }
    if (!isValidRequest(message)) {
      bridge.close(1008, "Invalid request.");
      return;
    }
    void handleRequest(message).then(
      (result) => sendReply(bridge, { type: "response", id: message.id, ok: true, result }),
      (error: unknown) => sendReply(bridge, {
        type: "response",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : "The browser operation failed."
      })
    );
  });

  bridge.addEventListener("close", () => {
    clearTimeout(timeout);
    if (socket !== bridge) return;
    stopKeepalive();
    socket = undefined;
    isConnecting = false;
    void chrome.storage.local.set({ connectionStatus: "disconnected" });
    reconnectTimer = setTimeout(() => void connectBridge(), 2500);
  });
  bridge.addEventListener("error", () => {
    void chrome.storage.local.set({ connectionStatus: "disconnected" });
  });
}

function disconnectBridge(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  stopKeepalive();
  socket?.close();
  socket = undefined;
  isConnecting = false;
}

function startKeepalive(bridge: WebSocket): void {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (bridge.readyState === WebSocket.OPEN) bridge.send(JSON.stringify({ type: "keepalive" }));
  }, 20_000);
}

function stopKeepalive(): void {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = undefined;
}

function sendReply(bridge: WebSocket, reply: BridgeReply): void {
  if (bridge.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(reply));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRequest(value: unknown): value is ExtensionRequest {
  if (!isObject(value) || value.type !== "request" || typeof value.id !== "string" || value.id.length > 64 || !isObject(value.params)) return false;
  const { params } = value;
  if (params.tabId !== undefined && (!Number.isInteger(params.tabId) || Number(params.tabId) < 1)) return false;

  switch (value.method) {
    case "tabs.list":
    case "page.inspect":
    case "page.screenshot":
      return true;
    case "page.scroll":
      return Number.isInteger(params.deltaY) && Math.abs(Number(params.deltaY)) <= 1000;
    case "page.click":
      return typeof params.selector === "string" && params.selector.length <= 2000 &&
        typeof params.expectedTag === "string" && params.expectedTag.length <= 32 &&
        typeof params.expectedName === "string" && params.expectedName.length <= 200;
    case "page.fill":
      return typeof params.selector === "string" && params.selector.length <= 2000 &&
        typeof params.expectedTag === "string" && params.expectedTag.length <= 32 &&
        typeof params.expectedName === "string" && params.expectedName.length <= 200 &&
        typeof params.value === "string" && params.value.length <= 4000;
    case "page.select":
      return typeof params.selector === "string" && params.selector.length <= 2000 &&
        typeof params.expectedName === "string" && params.expectedName.length <= 200 &&
        typeof params.value === "string" && params.value.length <= 1000;
    case "tabs.navigate":
      return typeof params.url === "string" && params.url.length <= 2048;
    default:
      return false;
  }
}

async function getSitePermissions(): Promise<SitePermission[]> {
  const stored = await chrome.storage.local.get("sites");
  if (!Array.isArray(stored.sites)) return [];
  return stored.sites.filter(isSitePermission);
}

async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const tab = tabId === undefined
    ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    : await chrome.tabs.get(tabId);
  if (!tab?.id || !tab.url) throw new Error("No usable browser tab is selected.");
  const url = new URL(tab.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("This browser page cannot be operated. Only HTTP and HTTPS pages are supported.");
  }
  return tab;
}

async function checkOriginPermission(origin: string): Promise<void> {
  const hasBrowserPermission = await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] });
  if (!hasBrowserPermission) {
    throw new Error(`This origin has not been granted to the extension. Add ${origin} in extension settings first.`);
  }
  const site = (await getSitePermissions()).find((item) => item.origin === origin);
  if (!site) throw new Error(`No site policy exists for ${origin}. Add it in extension settings first.`);
}

async function checkInteractivePermission(origin: string): Promise<SitePermission> {
  await checkOriginPermission(origin);
  const site = (await getSitePermissions()).find((item) => item.origin === origin);
  if (!site || site.mode !== "interact") {
    throw new Error(`This site is read-only. Enable interaction for ${origin} in extension settings.`);
  }
  return site;
}

async function requestConfirmation(
  tabId: number,
  origin: string,
  action: string,
  target: string,
  value?: string
): Promise<void> {
  const requestId = crypto.randomUUID();
  const message = {
    requestId,
    origin,
    action,
    target: target || "(unnamed page element)",
    value,
    createdAt: Date.now()
  };
  await recordAudit(origin, action, "requested");
  await chrome.storage.session.set({ [`confirmation:${requestId}`]: message });
  const decision = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      const pending = confirmations.get(requestId);
      const confirmationTabId = pending?.tabId;
      pending?.resolve(false);
      if (confirmationTabId && confirmationTabId > 0) {
        void chrome.tabs.remove(confirmationTabId).catch(() => undefined);
      }
    }, CONFIRMATION_TIMEOUT_MS);
    confirmations.set(requestId, {
      tabId: -1,
      resolve: (approved) => {
        clearTimeout(timeout);
        confirmations.delete(requestId);
        resolve(approved);
      }
    });
  });

  try {
    const confirmationTab = await chrome.tabs.create({
      url: `${chrome.runtime.getURL("confirm.html")}?requestId=${encodeURIComponent(requestId)}`,
      active: true
    });
    const pending = confirmations.get(requestId);
    if (pending) pending.tabId = confirmationTab.id ?? -1;
  } catch (error) {
    confirmations.get(requestId)?.resolve(false);
    await chrome.storage.session.remove(`confirmation:${requestId}`);
    await recordAudit(origin, action, "prompt-failed");
    throw new Error(`Could not open the confirmation window: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const approved = await decision;
  if (!approved) {
    await chrome.storage.session.remove(`confirmation:${requestId}`);
    await recordAudit(origin, action, "denied");
    throw new Error("Action was cancelled or confirmation expired.");
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || new URL(tab.url).origin !== origin) {
    await recordAudit(origin, action, "stale");
    throw new Error("The page changed while confirmation was open. Inspect the page and try again.");
  }
  const globalState = await chrome.storage.local.get("paused");
  if (globalState.paused === true) {
    await recordAudit(origin, action, "blocked-paused");
    throw new Error("Agent access was paused while the confirmation was open. No action was performed.");
  }
  await checkInteractivePermission(origin);
  await recordAudit(origin, action, "confirmed");
}

async function handleConfirmationMessage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const extensionPage = chrome.runtime.getURL("confirm.html");
  if (sender.url !== extensionPage && !sender.url?.startsWith(`${extensionPage}?`)) {
    return { ok: false, error: "Confirmation messages are only accepted from the extension confirmation page." };
  }

  if (message.type === "confirm:get" && typeof message.requestId === "string") {
    const stored = await chrome.storage.session.get(`confirmation:${message.requestId}`);
    return stored[`confirmation:${message.requestId}`] ?? null;
  }
  if (message.type === "confirm:resolve" && typeof message.requestId === "string" && typeof message.approved === "boolean") {
    const pending = confirmations.get(message.requestId);
    if (!pending) return { ok: false, error: "This confirmation has expired." };
    const stored = await chrome.storage.session.get(`confirmation:${message.requestId}`);
    const confirmation = stored[`confirmation:${message.requestId}`] as { createdAt?: unknown } | undefined;
    if (!confirmation || typeof confirmation.createdAt !== "number" || Date.now() - confirmation.createdAt > CONFIRMATION_TIMEOUT_MS) {
      pending.resolve(false);
      return { ok: false, error: "This confirmation has expired." };
    }
    pending.resolve(message.approved);
    if (pending.tabId > 0) await chrome.tabs.remove(pending.tabId).catch(() => undefined);
    await chrome.storage.session.remove(`confirmation:${message.requestId}`);
    return { ok: true };
  }
  return { ok: false, error: "Unsupported confirmation request." };
}

async function handleRequest(request: ExtensionRequest): Promise<unknown> {
  const state = await chrome.storage.local.get("paused");
  if (state.paused === true) throw new Error("Browser Agent is paused. Resume it in extension settings to continue.");

  switch (request.method) {
    case "tabs.list": {
      const tab = await getTargetTab();
      const origin = new URL(tab.url!).origin;
      await checkOriginPermission(origin);
      return [{ tabId: tab.id, origin, title: tab.title ?? "" }];
    }
    case "page.inspect": {
      const tab = await getTargetTab(request.params.tabId);
      const origin = new URL(tab.url!).origin;
      await checkOriginPermission(origin);
      await recordAudit(origin, "Inspect page", "allowed");
      return executePageOperation(tab.id!, "inspect", {});
    }
    case "page.click": {
      const tab = await getTargetTab(request.params.tabId);
      const origin = new URL(tab.url!).origin;
      await checkInteractivePermission(origin);
      const target = await executePageOperation(tab.id!, "describe", request.params) as {
        tag: string; name: string; href: string; formAction: string; formMethod: string;
      };
      const targetDescription = [
        `${target.tag}${target.name ? ` “${target.name}”` : ""}`,
        target.href ? `Destination: ${target.href}` : "",
        target.formAction ? `Form submission (${target.formMethod}): ${target.formAction}` : ""
      ].filter(Boolean).join(" · ");
      await requestConfirmation(tab.id!, origin, "Click element", targetDescription);
      const result = await executePageOperation(tab.id!, "click", {
        ...request.params,
        expectedHref: target.href,
        expectedFormAction: target.formAction,
        expectedFormMethod: target.formMethod
      });
      await recordAudit(origin, "Click element", "executed");
      return result;
    }
    case "page.fill": {
      const tab = await getTargetTab(request.params.tabId);
      const origin = new URL(tab.url!).origin;
      const permission = await checkInteractivePermission(origin);
      const field = await executePageOperation(tab.id!, "check-fill", request.params) as { sensitive: boolean; inputType: string; fillable: boolean };
      if (field.sensitive) {
        await recordAudit(origin, "Fill form field", "blocked-sensitive");
        throw new Error("Sensitive fields are blocked. Passwords, payment data, verification codes, and file inputs are never filled.");
      }
      if (!field.fillable) throw new Error("Only enabled text, search, URL, telephone, email, number, and multi-line text fields can be filled.");
      const allowlisted = mayAutoAllowFill(permission, field.inputType, field.sensitive);
      if (!allowlisted) {
        await requestConfirmation(tab.id!, origin, "Fill form field", request.params.expectedName, request.params.value);
      }
      const result = await executePageOperation(tab.id!, "fill", request.params);
      await recordAudit(origin, "Fill form field", "executed");
      return result;
    }
    case "page.select": {
      const tab = await getTargetTab(request.params.tabId);
      const origin = new URL(tab.url!).origin;
      await checkInteractivePermission(origin);
      const option = await executePageOperation(tab.id!, "describe-select", request.params) as { label: string };
      await requestConfirmation(tab.id!, origin, "Select option", request.params.expectedName, option.label);
      const result = await executePageOperation(tab.id!, "select", {
        ...request.params,
        expectedOptionLabel: option.label
      });
      await recordAudit(origin, "Select option", "executed");
      return result;
    }
    case "page.scroll": {
      const tab = await getTargetTab(request.params.tabId);
      const origin = new URL(tab.url!).origin;
      await checkOriginPermission(origin);
      const result = await executePageOperation(tab.id!, "scroll", request.params);
      await recordAudit(origin, "Scroll page", "allowed");
      return result;
    }
    case "tabs.navigate": {
      const tab = await getTargetTab(request.params.tabId);
      const target = new URL(request.params.url);
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Only HTTP and HTTPS navigation is allowed.");
      if (target.username || target.password) throw new Error("Navigation URLs cannot include embedded credentials.");
      await checkInteractivePermission(new URL(tab.url!).origin);
      await checkInteractivePermission(target.origin);
      await requestConfirmation(tab.id!, new URL(tab.url!).origin, "Navigate browser tab", target.href);
      const current = await chrome.tabs.get(tab.id!);
      if (!current.url || new URL(current.url).origin !== new URL(tab.url!).origin) {
        throw new Error("The source page changed during confirmation. Try again.");
      }
      await checkInteractivePermission(target.origin);
      await chrome.tabs.update(tab.id!, { url: target.href });
      await recordAudit(target.origin, "Navigate", "executed");
      return { navigated: true, url: target.href };
    }
    case "page.screenshot": {
      const tab = await getTargetTab(request.params.tabId);
      const origin = new URL(tab.url!).origin;
      await checkOriginPermission(origin);
      if (!await chrome.permissions.contains({ permissions: ["tabs"] })) {
        throw new Error("Screenshot permission is disabled. Grant it in extension settings before requesting a screenshot.");
      }
      const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (active[0]?.id !== tab.id) throw new Error("Only the currently visible active tab can be captured.");
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
      await recordAudit(origin, "Capture screenshot", "allowed");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) throw new Error("The browser returned an invalid screenshot.");
      return { mimeType: "image/jpeg", base64: dataUrl.slice(comma + 1) };
    }
  }
}

async function executePageOperation(tabId: number, operation: string, params: Record<string, unknown>): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: runPageOperation,
    args: [operation, params]
  });
  const result = results[0]?.result;
  if (result === undefined) throw new Error("The page did not return a result.");
  if (isObject(result) && result.error) throw new Error(String(result.error));
  return result;
}

function runPageOperation(operation: string, params: Record<string, unknown>): unknown {
  const maxText = 15_000;
  const isSensitive = (element: Element): boolean => {
    const field = element as HTMLInputElement;
    const metadata = [
      field.type,
      field.autocomplete,
      field.name,
      field.id,
      field.getAttribute("aria-label"),
      field.getAttribute("placeholder"),
      field.labels ? Array.from(field.labels).map((label) => label.innerText).join(" ") : ""
    ].join(" ").toLowerCase();
    return ["password", "file", "hidden"].includes(field.type) ||
      /current-password|new-password|cc-|one-time-code|webauthn/.test(metadata) ||
      /password|passcode|verification code|security code|credit card|card number|cvv|cvc|social security|ssn|\botp\b|authenticator|bank account|routing number|\biban\b|\b2fa\b|api key|private key|secret|\btoken\b/.test(metadata);
  };

  const selectorFor = (element: Element): string => {
    const withId = element.id ? `#${CSS.escape(element.id)}` : "";
    if (withId && document.querySelectorAll(withId).length === 1) return withId;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const tag = current.localName;
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((child) => child.localName === tag)
        : [];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return `html > ${parts.join(" > ")}`;
  };

  const getName = (element: Element): string => {
    const field = element as HTMLInputElement;
    const label = field.labels ? Array.from(field.labels).map((item) => item.innerText.trim()).join(" ") : "";
    return (
      element.getAttribute("aria-label") ||
      label ||
      element.getAttribute("title") ||
      element.getAttribute("alt") ||
      (element instanceof HTMLInputElement ? element.placeholder : "") ||
      element.textContent?.trim().replace(/\s+/g, " ").slice(0, 200) ||
      ""
    ).trim().slice(0, 200);
  };

  const formSubmission = (element: Element): { action: string; method: string } | undefined => {
    const isSubmit = (element instanceof HTMLButtonElement && element.type === "submit") ||
      (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type));
    if (!isSubmit) return undefined;
    const control = element as HTMLButtonElement;
    const form = control.form;
    return {
      action: element.hasAttribute("formaction") ? control.formAction : form?.action ?? location.href,
      method: element.hasAttribute("formmethod") ? control.formMethod.toLowerCase() : form?.method ?? "get"
    };
  };

  const isVisible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };

  if (operation === "inspect") {
    const interactive = Array.from(document.querySelectorAll(
      'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])'
    )).filter((element) => isVisible(element) && !isSensitive(element)).slice(0, 200);
    const elements = interactive.map((element) => {
      const tag = element.localName;
      const inputType = element instanceof HTMLInputElement ? element.type : undefined;
      const role = element.getAttribute("role") ||
        (tag === "a" ? "link" : tag === "button" ? "button" : tag === "textarea" ? "textbox" :
          tag === "select" ? "combobox" : tag === "input" && ["button", "submit", "reset"].includes(inputType ?? "")
            ? "button" : tag === "input" && inputType === "checkbox" ? "checkbox" :
              tag === "input" && inputType === "radio" ? "radio" : tag === "input" ? "textbox" : "generic");
      const submission = formSubmission(element);
      return {
        selector: selectorFor(element),
        tag,
        role,
        name: getName(element),
        text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 200),
        disabled: "disabled" in element && Boolean((element as HTMLButtonElement).disabled),
        ...(inputType ? { inputType } : {}),
        ...(element instanceof HTMLAnchorElement ? { href: element.href.slice(0, 2048) } : {}),
        ...(submission ? { formAction: submission.action, formMethod: submission.method } : {}),
        ...(element instanceof HTMLSelectElement
          ? { options: Array.from(element.options).slice(0, 50).map((option) => ({ label: option.label.slice(0, 200), value: option.value.slice(0, 200) })) }
          : {})
      };
    });
    const bodyText = document.body?.innerText ?? "";
    const text = bodyText.slice(0, maxText);
    return {
      url: `${location.origin}${location.pathname}`,
      title: document.title.slice(0, 300),
      text,
      elements,
      truncated: bodyText.length > maxText
    } satisfies PageSnapshot;
  }

  if (typeof params.selector !== "string") return { error: "A valid element selector is required." };
  let element: Element | null;
  try {
    element = document.querySelector(params.selector);
  } catch {
    return { error: "The element selector is invalid." };
  }
  if (!element || !isVisible(element)) return { error: "The element is missing or not visible. Inspect the page again." };
  const expectedTag = typeof params.expectedTag === "string"
    ? params.expectedTag
    : operation === "select" ? "select" : "";
  if (!expectedTag || element.localName !== expectedTag) return { error: "The page changed and the target element no longer matches. Inspect again." };
  if (getName(element) !== params.expectedName) return { error: "The page changed and the target name no longer matches. Inspect again." };
  if ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) return { error: "The target element is disabled." };

  if (operation === "check-fill") {
    const fillableTypes = ["text", "search", "url", "tel", "email", "number"];
    const fillable = element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement && fillableTypes.includes(element.type));
    return {
      sensitive: isSensitive(element),
      inputType: element instanceof HTMLInputElement ? element.type : "textarea",
      fillable
    };
  }
  if (operation === "describe") {
    const submission = formSubmission(element);
    const href = element instanceof HTMLAnchorElement ? element.href : "";
    if (href && (!["http:", "https:"].includes(new URL(href).protocol) || new URL(href).username || new URL(href).password)) {
      return { error: "Links to non-web protocols or URLs containing credentials are blocked." };
    }
    if (submission) {
      const action = new URL(submission.action);
      if (!["http:", "https:"].includes(action.protocol) || action.username || action.password) {
        return { error: "Form submissions to non-web protocols or URLs containing credentials are blocked." };
      }
    }
    if (href.length > 2048 || (submission?.action.length ?? 0) > 2048) {
      return { error: "This target has an oversized URL and cannot be safely confirmed." };
    }
    return {
      tag: element.localName,
      name: getName(element),
      href,
      formAction: submission?.action ?? "",
      formMethod: submission?.method ?? ""
    };
  }
  if (operation === "describe-select") {
    if (!(element instanceof HTMLSelectElement) || typeof params.value !== "string") {
      return { error: "The selected target is not a valid dropdown option." };
    }
    const option = Array.from(element.options).find((candidate) => candidate.value === params.value);
    if (!option) return { error: "The requested option is no longer available. Inspect the page again." };
    return { label: option.label || option.textContent?.trim() || "(unnamed option)" };
  }
  if (operation === "click") {
    const tag = element.localName;
    const role = element.getAttribute("role");
    const isInteractive = ["a", "button", "input", "select", "textarea"].includes(tag) ||
      role === "button" || role === "link" ||
      (element instanceof HTMLElement && element.tabIndex >= 0);
    if (!isInteractive) return { error: "Only visible interactive elements may be clicked." };
    if (isSensitive(element)) return { error: "Sensitive controls cannot be operated." };
    if (element instanceof HTMLAnchorElement) {
      if (!["http:", "https:"].includes(new URL(element.href).protocol)) {
        return { error: "Links that open external applications or non-web protocols are blocked." };
      }
      if (typeof params.expectedHref !== "string" || params.expectedHref !== element.href) {
        return { error: "The link destination changed during confirmation. Inspect the page and try again." };
      }
    }
    const submission = formSubmission(element);
    if (submission) {
      if (params.expectedFormAction !== submission.action || params.expectedFormMethod !== submission.method) {
        return { error: "The form destination or method changed during confirmation. Inspect the page and try again." };
      }
    }
    (element as HTMLElement).click();
    return { clicked: true, target: getName(element) };
  }
  if (operation === "fill") {
    if (typeof params.value !== "string") return { error: "A text value is required." };
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return { error: "Only text inputs and textareas can be filled." };
    }
    if (element instanceof HTMLInputElement && !["text", "search", "url", "tel", "email", "number"].includes(element.type)) {
      return { error: "This input type cannot be filled with text." };
    }
    if (isSensitive(element)) return { error: "Sensitive fields are blocked." };
    if (element.disabled || element.readOnly) return { error: "The target field is disabled or read-only." };
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return { error: "Could not safely update the target field." };
    setter.call(element, params.value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, target: getName(element) };
  }
  if (operation === "select") {
    if (!(element instanceof HTMLSelectElement)) return { error: "Only select fields can be changed with this tool." };
    if (typeof params.value !== "string" || !Array.from(element.options).some((option) => option.value === params.value)) {
      return { error: "The requested option is not available in this select field." };
    }
    const option = Array.from(element.options).find((candidate) => candidate.value === params.value);
    const label = option?.label || option?.textContent?.trim() || "(unnamed option)";
    if (params.expectedOptionLabel !== label) {
      return { error: "The selected option changed during confirmation. Inspect the page and try again." };
    }
    if (element.disabled) return { error: "The select field is disabled." };
    element.value = params.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: true, target: getName(element) };
  }
  if (operation === "scroll") {
    if (typeof params.deltaY !== "number" || !Number.isInteger(params.deltaY) || Math.abs(params.deltaY) > 1000) {
      return { error: "Scroll distance must be an integer between -1000 and 1000." };
    }
    window.scrollBy({ top: params.deltaY, behavior: "auto" });
    return { scrolled: true, scrollY: window.scrollY };
  }
  return { error: "Unsupported page operation." };
}

async function recordAudit(origin: string, action: string, result: string): Promise<void> {
  const write = auditQueue.then(async () => {
    const { auditLog } = await chrome.storage.local.get("auditLog");
    const entries = Array.isArray(auditLog) ? auditLog : [];
    entries.unshift({ at: Date.now(), origin, action, result });
    await chrome.storage.local.set({ auditLog: entries.slice(0, 50) });
  });
  auditQueue = write.catch(() => undefined);
  await write;
}

function isConfirmationMessage(value: unknown): value is Record<string, unknown> {
  return isObject(value) && (
    value.type === "confirm:get" ||
    (value.type === "confirm:resolve" && typeof value.approved === "boolean")
  ) && typeof value.requestId === "string";
}
