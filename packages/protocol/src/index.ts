export const CONFIRMATION_TIMEOUT_MS = 60_000;
export const BRIDGE_REQUEST_TIMEOUT_MS = CONFIRMATION_TIMEOUT_MS + 60_000;

export type SitePermission = {
  origin: string;
  mode: "readonly" | "interact";
  allowFill: boolean;
  allowAllActions?: boolean;
};

export type ExtensionRequest =
  | { type: "request"; id: string; method: "tabs.list"; params: Record<string, never> }
  | { type: "request"; id: string; method: "page.inspect"; params: { tabId?: number } }
  | { type: "request"; id: string; method: "page.click"; params: { tabId?: number; selector: string; expectedTag: string; expectedName: string } }
  | { type: "request"; id: string; method: "page.fill"; params: { tabId?: number; selector: string; value: string; expectedTag: string; expectedName: string } }
  | { type: "request"; id: string; method: "page.select"; params: { tabId?: number; selector: string; value: string; expectedName: string } }
  | { type: "request"; id: string; method: "page.scroll"; params: { tabId?: number; deltaY: number } }
  | { type: "request"; id: string; method: "tabs.navigate"; params: { tabId?: number; url: string } }
  | { type: "request"; id: string; method: "page.screenshot"; params: { tabId?: number } };

export type ExtensionCall = ExtensionRequest extends infer Request
  ? Request extends { type: "request"; id: string }
    ? Omit<Request, "type" | "id">
    : never
  : never;

export type BridgeMessage =
  | { type: "hello"; token: string }
  | { type: "keepalive" }
  | ExtensionRequest;

export type BridgeReply =
  | { type: "ready" }
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: string };

export type PageElement = {
  selector: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  disabled: boolean;
  inputType?: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  options?: { label: string; value: string }[];
};

export type PageSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  truncated: boolean;
};
