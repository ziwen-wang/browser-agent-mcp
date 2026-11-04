import assert from "node:assert/strict";
import test from "node:test";
import {
  hostPermissionPattern,
  isSitePermission,
  mayAutoAllowFill,
  maySkipActionConfirmation,
  parseExactOrigin
} from "../dist/policy.js";

test("exact origin parser rejects non-web schemes and URL components", () => {
  assert.equal(parseExactOrigin("https://example.com"), "https://example.com");
  assert.equal(parseExactOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(parseExactOrigin("javascript:alert(1)"), null);
  assert.equal(parseExactOrigin("file:///etc/passwd"), null);
  assert.equal(parseExactOrigin("https://user:pass@example.com"), null);
  assert.equal(parseExactOrigin("https://example.com/path"), null);
  assert.equal(parseExactOrigin("https://example.com/?token=secret"), null);
  assert.equal(parseExactOrigin("https://*.example.com"), null);
});

test("browser host grants are broad but remain constrained to a canonical origin in policy", () => {
  assert.equal(hostPermissionPattern("https://example.com:8443"), "https://example.com/*");
  assert.equal(
    isSitePermission({ origin: "https://example.com:8443", mode: "readonly", allowFill: false }),
    true
  );
  assert.equal(
    isSitePermission({ origin: "https://example.com:8443", mode: "readonly", allowFill: true }),
    true
  );
});

test("fill allowlisting is limited to non-sensitive search fields on interactive sites", () => {
  const site = { origin: "https://example.com", mode: "interact", allowFill: true };
  assert.equal(mayAutoAllowFill(site, "search", false), true);
  assert.equal(mayAutoAllowFill(site, "text", false), false);
  assert.equal(mayAutoAllowFill(site, "search", true), false);
  assert.equal(mayAutoAllowFill({ ...site, mode: "readonly" }, "search", false), false);
  assert.equal(mayAutoAllowFill({ ...site, mode: "readonly" }, "search", true), false);
  assert.equal(mayAutoAllowFill({ ...site, allowFill: false }, "search", false), false);
});

test("allow-all confirmation policy is limited to interaction-enabled sites", () => {
  const site = { origin: "https://example.com", mode: "interact", allowFill: false };
  assert.equal(maySkipActionConfirmation({ ...site, allowAllActions: true }), true);
  assert.equal(maySkipActionConfirmation({ ...site, allowAllActions: false }), false);
  assert.equal(maySkipActionConfirmation({ ...site, mode: "readonly", allowAllActions: true }), false);
  assert.equal(isSitePermission({ ...site, allowAllActions: true }), true);
  assert.equal(isSitePermission({ ...site, allowAllActions: "yes" }), false);
});
