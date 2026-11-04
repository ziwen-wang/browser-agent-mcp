import "./style.css";
import { CONFIRMATION_TIMEOUT_MS } from "@browser-agent-mcp/protocol";

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
    fail("This request is invalid or has expired.");
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "confirm:get", requestId });
  if (!response || typeof response !== "object") {
    fail("This request is no longer available. Close this tab and retry the action.");
    return;
  }
  const data = response as ConfirmationData;
  if (typeof data.origin !== "string" || typeof data.action !== "string" ||
    typeof data.target !== "string" || typeof data.createdAt !== "number" ||
    Date.now() - data.createdAt > CONFIRMATION_TIMEOUT_MS) {
    fail("This request is invalid or has expired.");
    return;
  }

  (document.getElementById("origin") as HTMLElement).textContent = data.origin;
  (document.getElementById("action") as HTMLElement).textContent = data.action;
  (document.getElementById("target") as HTMLElement).textContent = data.target;
  if (typeof data.value === "string") {
    (document.getElementById("value") as HTMLElement).textContent = data.value || "(empty value)";
    document.getElementById("value-row")?.classList.add("visible");
  }
}

async function resolve(approved: boolean): Promise<void> {
  if (!requestId) return;
  approve.disabled = true;
  deny.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "confirm:resolve", requestId, approved });
    if (!result?.ok) fail(result?.error ?? "This request has expired.");
  } catch {
    fail("Could not send your decision. The action was not approved.");
  }
}

approve.addEventListener("click", () => void resolve(true));
deny.addEventListener("click", () => void resolve(false));
void load().catch(() => fail("Could not load this confirmation. The action was not approved."));
