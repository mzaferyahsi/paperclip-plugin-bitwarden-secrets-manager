import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { validateConfig, publicConfig } from "../src/config.ts";

const valid = {
  enabled: true,
  bsmAccessToken: { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440000", version: "latest" },
  paperclipApiToken: { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440001" },
  bsmOrganizationId: "550e8400-e29b-41d4-a716-446655440002",
  bsmProjectIds: ["550e8400-e29b-41d4-a716-446655440003"],
  paperclipApiOrigin: "https://paperclip.example/",
  destinationScope: "company",
};

test("requires native secret_ref objects and rejects legacy string refs", () => {
  assert.equal(validateConfig(valid), null);
  assert.equal(validateConfig({ ...valid, bsmAccessToken: "550e8400-e29b-41d4-a716-446655440000" }), "bsm_credential_required");
});

test("enforces company scope, HTTPS origin, and a non-empty unique project allowlist", () => {
  assert.equal(validateConfig({ ...valid, destinationScope: "user" }), "unsupported_destination_scope");
  assert.equal(validateConfig({ ...valid, paperclipApiOrigin: "http://paperclip.example" }), "paperclip_origin_invalid");
  assert.equal(validateConfig({ ...valid, bsmProjectIds: [] }), "project_allowlist_invalid");
  assert.equal(validateConfig({ ...valid, bsmProjectIds: [valid.bsmProjectIds[0], valid.bsmProjectIds[0]] }), "project_allowlist_invalid");
});

test("settings projection does not expose string credentials or unknown config fields", () => {
  const safe = publicConfig({ ...valid, bsmAccessToken: "fixture-token", unexpectedToken: "leak-me" });
  assert.equal(safe.bsmAccessToken, null);
  assert.equal("unexpectedToken" in safe, false);
  assert.equal(JSON.stringify(safe).includes("fixture-token"), false);
});

test("manifest validates against installed Paperclip schema and declares both UI slots", async () => {
  const require = createRequire(import.meta.url);
  const { pluginManifestV1Schema } = require("../node_modules/@paperclipai/shared/dist/validators/plugin.js");
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const parsed = pluginManifestV1Schema.parse(manifest);
  assert.ok(parsed.capabilities.includes("companies.read"));
  assert.ok(parsed.ui.slots.some((slot) => slot.type === "settingsPage" && slot.exportName === "BsmSettingsPage"));
  assert.ok(parsed.ui.slots.some((slot) => slot.type === "dashboardWidget" && slot.exportName === "BsmStatusWidget"));
});
