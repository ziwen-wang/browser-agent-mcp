import type { SitePermission } from "./index.js";

export function parseExactOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname.includes("*")) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isExactHttpOrigin(value: string): boolean {
  return parseExactOrigin(value) === value;
}

export function hostPermissionPattern(origin: string): string {
  if (!isExactHttpOrigin(origin)) throw new Error("A canonical HTTP(S) origin is required.");
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export function isSitePermission(value: unknown): value is SitePermission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<SitePermission>;
  return typeof item.origin === "string" &&
    isExactHttpOrigin(item.origin) &&
    (item.mode === "readonly" || item.mode === "interact") &&
    typeof item.allowFill === "boolean" &&
    (item.allowAllActions === undefined || typeof item.allowAllActions === "boolean");
}

export function mayAutoAllowFill(site: SitePermission, inputType: string, sensitive: boolean): boolean {
  return site.mode === "interact" && site.allowFill && inputType === "search" && !sensitive;
}

export function maySkipActionConfirmation(site: SitePermission): boolean {
  return site.mode === "interact" && site.allowAllActions === true;
}
