import "./style.css";
import { CONFIRMATION_TIMEOUT_MS } from "@browser-agent-mcp/protocol";
import { initializeLanguage, t, translateAuditValue } from "../shared/i18n";

type ConfirmationData = {
  requestId: string;
  origin: string;
  action: string;
  target: string;
  value?: string;
  createdAt: number;
};

const requestId = new URL(location.href).searchParams.get("requestId");
const error = document.getElementById("error") as HTMLParagraphElement;
const approve = document.getElementById("approve") as HTMLButtonElement;
const deny = document.getElementById("deny") as HTMLButtonElement;

function fail(message: string): void {
  error.textContent = message;
  approve.disabled = true;
  deny.disabled = true;
}

async function load(): Promise<void> {
  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    fail(t("confirm.invalid"));
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "confirm:get", requestId });
  if (!response || typeof response !== "object") {
    fail(t("confirm.unavailable"));
    return;
  }
  const data = response as ConfirmationData;
  if (typeof data.origin !== "string" || typeof data.action !== "string" ||
    typeof data.target !== "string" || typeof data.createdAt !== "number" ||
    Date.now() - data.createdAt > CONFIRMATION_TIMEOUT_MS) {
    fail(t("confirm.invalid"));
    return;
  }

  (document.getElementById("origin") as HTMLElement).textContent = data.origin;
  (document.getElementById("action") as HTMLElement).textContent = translateAuditValue(data.action);
  (document.getElementById("target") as HTMLElement).textContent = data.target;
  if (typeof data.value === "string") {
    (document.getElementById("value") as HTMLElement).textContent = data.value || t("confirm.empty");
    document.getElementById("value-row")?.classList.add("visible");
  }
}

async function resolve(approved: boolean): Promise<void> {
  if (!requestId) return;
  approve.disabled = true;
  deny.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "confirm:resolve", requestId, approved });
    if (!result?.ok) {
      fail(result?.error === "This request has expired." || !result?.error
        ? t("confirm.expired")
        : result.error);
    }
  } catch {
    fail(t("confirm.sendFailed"));
  }
}

approve.addEventListener("click", () => void resolve(true));
deny.addEventListener("click", () => void resolve(false));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.uiLanguage) {
    void load().catch(() => fail(t("confirm.loadFailed")));
  }
});
void initializeLanguage()
  .then(load)
  .catch(() => fail(t("confirm.loadFailed")));
