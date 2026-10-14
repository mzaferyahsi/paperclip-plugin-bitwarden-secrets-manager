import test from "node:test";
import assert from "node:assert/strict";
import { registerSettingsActions } from "../.test-build/settings-actions.js";
import { registerRuntime, buildStatus, AdapterError } from "../.test-build/runtime.js";
import { ERROR_CODES, AUTHORIZATION_BLOCKED } from "../.test-build/error-codes.js";
import { describeCode } from "../.test-build/messages.js";

const companyId = "550e8400-e29b-41d4-a716-446655440010";
const uuid = (n) => `550e8400-e29b-41d4-a716-4466554400${n}`;
const setupRef = { type: "secret_ref", secretId: uuid(11) };
const runtimeRef = { type: "secret_ref", secretId: uuid(12) };
const bsmRef = { type: "secret_ref", secretId: uuid(16), version: "latest" };
const full = {
  enabled: false, paperclipSetupApiToken: setupRef, paperclipApiToken: runtimeRef, bsmAccessToken: bsmRef,
  paperclipApiOrigin: "https://paperclip.example/", bsmOrganizationId: uuid(13), bsmProjectIds: [uuid(14)],
  destinationScope: "company", syncIntervalMinutes: 15, targetSecretKeyPrefix: "bitwarden.",
};
const settings = { bsmOrganizationId: full.bsmOrganizationId, bsmProjectIds: full.bsmProjectIds, paperclipApiOrigin: full.paperclipApiOrigin,
  destinationScope: "company", syncIntervalMinutes: 15, targetSecretKeyPrefix: "bitwarden.", archiveOnRemoval: false, bitwardenRegion: "US" };
const actor = { actor: { type: "user", userId: "user-a" }, companyId };

function harness(initial = full, identity = { userId: "user-a", isInstanceAdmin: true, companyIds: [companyId] }) {
  const actions = {};
  const store = { config: { ...initial } };
  const writes = [];
  const ctx = {
    actions: { register: (key, fn) => { actions[key] = fn; } },
    config: { get: async () => store.config },
    secrets: { resolve: async () => "fixture-setup-credential" },
    http: { fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/api/cli-auth/me") return Response.json(identity);
      if (path.endsWith("/config")) { const body = JSON.parse(init.body); writes.push(body.configJson); store.config = body.configJson; return Response.json({ ok: true }); }
      return Response.json({}, { status: 404 });
    } },
  };
  registerSettingsActions(ctx);
  return { actions, store, writes };
}

for (const [name, params] of [["save-settings", { companyId, settings }], ["set-enabled", { companyId, enabled: true }]]) {
  test(`${name} without setup authority is rejected and changes nothing`, async () => {
    const { setup: _s, paperclipSetupApiToken: _t, ...noSetup } = full;
    const h = harness(noSetup);
    assert.deepEqual(await h.actions[name](params, actor), { ok: false, errorCode: "setup_credential_required", field: null });
    const wrong = harness(full, { userId: "other", isInstanceAdmin: true, companyIds: [companyId] });
    assert.equal((await wrong.actions[name](params, actor)).errorCode, "setup_identity_mismatch");
    assert.deepEqual([...h.writes, ...wrong.writes], []);
    assert.equal((await h.actions[name](params, { actor: { type: "agent", userId: null }, companyId })).errorCode, "user_context_required");
  });
}

test("save-settings writes enabled:false, keeps refs, returns the contract shape", async () => {
  const h = harness({ ...full, enabled: true });
  const result = await h.actions["save-settings"]({ companyId, settings: { ...settings, syncIntervalMinutes: 30 } }, actor);
  assert.deepEqual(result, { ok: true, errorCode: null, field: null, enabled: false });
  assert.equal(h.writes[0].enabled, false);
  assert.deepEqual(h.writes[0].paperclipApiToken, runtimeRef);
  assert.deepEqual(h.writes[0].bsmAccessToken, bsmRef);
});

test("save-settings reports the failing field", async () => {
  const h = harness();
  const result = await h.actions["save-settings"]({ companyId, settings: { ...settings, bsmOrganizationId: "nope" } }, actor);
  assert.deepEqual(result, { ok: false, errorCode: "organization_invalid", field: "bsmOrganizationId" });
  assert.equal(h.writes.length, 0);
});

test("an origin change is refused while a runtime ref exists, in every writing action; unchanged is accepted", async () => {
  const h = harness();
  const changed = { ...settings, paperclipApiOrigin: "https://evil.example/" };
  assert.deepEqual(await h.actions["save-settings"]({ companyId, settings: changed }, actor), { ok: false, errorCode: "paperclip_origin_invalid", field: "paperclipApiOrigin" });
  assert.equal((await h.actions["save-token"]({ companyId, token: "x", operationId: uuid(17), settings: changed }, actor)).errorCode, "paperclip_origin_invalid");
  assert.equal((await h.actions["select-secret"]({ companyId, secretId: uuid(16), settings: changed }, actor)).errorCode, "paperclip_origin_invalid");
  assert.equal(h.writes.length, 0);
  assert.equal((await h.actions["save-settings"]({ companyId, settings }, actor)).ok, true);
});

test("set-enabled true needs valid config and both refs; false is always accepted", async () => {
  const h = harness();
  assert.deepEqual(await h.actions["set-enabled"]({ companyId, enabled: true }, actor), { ok: true, errorCode: null, field: null, enabled: true });
  assert.equal(h.writes.at(-1).enabled, true);
  assert.deepEqual(h.writes.at(-1).paperclipSetupApiToken, setupRef);
  assert.equal((await h.actions["set-enabled"]({ companyId, enabled: false }, actor)).enabled, false);
  assert.equal(h.writes.at(-1).enabled, false);

  const { bsmAccessToken: _b, ...noBsm } = full;
  const missingBsm = harness(noBsm);
  assert.equal((await missingBsm.actions["set-enabled"]({ companyId, enabled: true }, actor)).errorCode, "bsm_credential_required");
  const { paperclipApiToken: _p, ...noRuntime } = full;
  const missingRuntime = harness(noRuntime);
  assert.equal((await missingRuntime.actions["set-enabled"]({ companyId, enabled: true }, actor)).errorCode, "paperclip_credential_required");
  const badScope = harness({ ...full, bsmProjectIds: [] });
  assert.deepEqual(await badScope.actions["set-enabled"]({ companyId, enabled: true }, actor), { ok: false, errorCode: "project_allowlist_invalid", field: "bsmProjectIds" });
  assert.equal(missingBsm.writes.length + missingRuntime.writes.length + badScope.writes.length, 0);
  assert.equal((await missingBsm.actions["set-enabled"]({ companyId, enabled: false }, actor)).ok, true);
  assert.equal((await h.actions["set-enabled"]({ companyId, enabled: "yes" }, actor)).errorCode, "settings_invalid");
});

test("the page cannot write the runtime or setup refs", async () => {
  const h = harness();
  const evil = { type: "secret_ref", secretId: uuid(99) };
  await h.actions["save-settings"]({ companyId, settings: { ...settings, paperclipApiToken: evil, paperclipSetupApiToken: evil } }, actor);
  assert.deepEqual(h.writes[0].paperclipApiToken, runtimeRef);
  assert.deepEqual(h.writes[0].paperclipSetupApiToken, setupRef);
});

function runtimeHarness(config, seeded = {}) {
  const handlers = { actions: {}, jobs: {} };
  const state = new Map(Object.entries(seeded).map(([id, v]) => [`${id}/runtime`, v]));
  const resolved = [];
  const activity = [];
  const ctx = {
    jobs: { register: (k, f) => { handlers.jobs[k] = f; } }, data: { register() {} },
    actions: { register: (k, f) => { handlers.actions[k] = f; } },
    companies: { list: async () => [{ id: "c" }], get: async () => ({ id: "c" }) },
    config: { get: async () => config },
    state: { get: async ({ scopeId, stateKey }) => state.get(`${scopeId}/${stateKey}`) ?? null, set: async ({ scopeId, stateKey }, v) => { state.set(`${scopeId}/${stateKey}`, v); } },
    secrets: { resolve: async (_r, o) => { resolved.push(o.configPath); return "fixture-secret-value"; } },
    activity: { log: async (e) => activity.push(e) }, logger: { error() {}, info() {}, warn() {}, debug() {} },
  };
  return { handlers, state, resolved, activity, ctx };
}
const runCfg = { enabled: true, bsmAccessToken: bsmRef, paperclipApiToken: runtimeRef, bsmOrganizationId: uuid(13), bsmProjectIds: [uuid(14)], paperclipApiOrigin: "https://paperclip.example/" };

test("resync is not registered", () => {
  const r = runtimeHarness(runCfg);
  registerRuntime(r.ctx, {});
  assert.equal("resync" in r.handlers.actions, false);
  assert.deepEqual(Object.keys(r.handlers.actions).sort(), ["get-status"]);
});

test("get-status matches the ADR contract exactly and leaks no names, keys or IDs", async () => {
  const summary = { sourceCount: 3, created: 1, rotated: 1, nativeDriftCorrected: 0, metadataUpdated: 0, unchanged: 1, archived: 0, skippedArchived: 0, failed: 0 };
  const r = runtimeHarness(runCfg, { c: { status: "success", lastAttemptAt: "2026-01-01T00:00:00.000Z", lastSuccessAt: "2026-01-01T00:00:00.000Z",
    scheduledAnchor: "2026-01-01T00:00:00.000Z", processedCompanies: 4, runtimeRefIds: [uuid(16), uuid(12)], itemJournal: [{ sourceId: "SECRET-SOURCE-ID" }],
    lastRunSummary: { ...summary, name: "DB_PASSWORD" } } });
  registerRuntime(r.ctx, {});
  const status = await r.handlers.actions["get-status"]({}, { actor: { type: "user", userId: "u" }, companyId: "c" });
  assert.deepEqual(Object.keys(status).sort(), ["configured", "enabled", "errorCode", "lastAttemptAt", "lastRunSummary", "lastSuccessAt", "nextEligibleAt", "status", "warningCode"]);
  assert.deepEqual(status.lastRunSummary, summary); // the stray name key in stored state is dropped
  const ok = runtimeHarness(runCfg, { c: { status: "success", scheduledAnchor: "2026-01-01T00:00:00.000Z", lastRunSummary: summary, processedCompanies: 9 } });
  registerRuntime(ok.ctx, {});
  const good = await ok.handlers.actions["get-status"]({}, { actor: { type: "user", userId: "u" }, companyId: "c" });
  assert.deepEqual(good.lastRunSummary, summary);
  assert.equal("processedCompanies" in good, false);
  assert.equal(good.enabled, true);
  assert.equal(good.configured, true);
  assert.match(good.nextEligibleAt, /^\d{4}-\d\d-\d\dT\d\d:\d[05]:00\.000Z$/);
  const text = JSON.stringify([status, good]);
  for (const leak of ["DB_PASSWORD", "SECRET-SOURCE-ID", uuid(16), uuid(12), "fixture-secret-value"]) assert.equal(text.includes(leak), false);
});

test("nextEligibleAt: null when disabled or blocked; backoff wins; rounded up to the 5-minute tick", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(buildStatus({ ...runCfg, enabled: false }, { scheduledAnchor: "2026-01-01T00:00:00.000Z" }, now).nextEligibleAt, null);
  assert.equal(buildStatus(runCfg, { errorCode: "bsm_credential_rejected", scheduledAnchor: "2026-01-01T00:00:00.000Z" }, now).nextEligibleAt, null);
  assert.equal(buildStatus(runCfg, { errorCode: "remote_unavailable", nextEligibleAt: "2026-01-01T01:02:10.000Z", scheduledAnchor: "2026-01-01T00:00:00.000Z" }, now).nextEligibleAt, "2026-01-01T01:05:00.000Z");
  assert.equal(buildStatus(runCfg, { scheduledAnchor: "2026-01-01T00:01:00.000Z" }, now).nextEligibleAt, "2026-01-01T00:20:00.000Z");
  assert.equal(buildStatus({}, {}, now).configured, false);
});

for (const [message, code] of [["Bitwarden SDK: 401 Unauthorized", "bsm_credential_rejected"], ["403 Forbidden", "bsm_permission_denied"]]) {
  test(`Bitwarden ${code} blocks scheduled retries but not a host manual run`, async () => {
    const r = runtimeHarness(runCfg);
    registerRuntime(r.ctx, {
      createSdk: async () => ({ listSecretIds: async () => { throw new AdapterError(code); }, getSecrets: async () => [] }),
      createTransport: () => async () => ({ status: 200, json: async () => [] }),
    });
    const run = (trigger, at) => r.handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "r", trigger, scheduledAt: at });
    await run("schedule", "2026-01-01T00:00:00.000Z");
    assert.equal(r.state.get("c/runtime").errorCode, code);
    assert.equal(r.state.get("c/runtime").status, "configuration_required");
    const before = r.resolved.length;
    await run("schedule", "2026-01-01T00:15:00.000Z");
    assert.equal(r.resolved.length, before);
    await run("manual", "2026-01-01T00:20:00.000Z");
    assert.ok(r.resolved.length > before);
    assert.equal(AUTHORIZATION_BLOCKED.has(code), true);
  });
}

test("Bitwarden SDK 401 and 403 messages normalize to the new codes", async () => {
  const { bitwardenSdkAdapter } = await import("../.test-build/bitwarden-adapter.mjs");
  for (const [text, code] of [["401 Unauthorized", "bsm_credential_rejected"], ["403 Forbidden", "bsm_permission_denied"]]) {
    const adapter = bitwardenSdkAdapter({ secrets: () => ({ list: async () => ({ success: false, errorMessage: text }), getByIds: async () => ({ success: true, data: { data: [] } }) }) });
    await assert.rejects(adapter.listSecretIds("o"), (e) => e.code === code);
  }
});

test("every ERROR_CODES entry has UI copy and a retry class and severity", async () => {
  const ui = await import("../.test-build/ui.mjs");
  for (const [code, info] of Object.entries(ERROR_CODES)) {
    assert.ok(ui.ERROR_COPY[code]?.title && ui.ERROR_COPY[code]?.action, `missing UI copy for ${code}`);
    assert.ok(["auto", "blocked", "none"].includes(info.retry));
    assert.ok(["error", "warning", "info"].includes(info.severity));
  }
  assert.deepEqual(ui.copyCoverage(), []);
  const unknown = ui.errorCopy("zz_unknown_zz");
  assert.equal(unknown.title, "Something went wrong");
  assert.equal(unknown.code, "zz_unknown_zz");
  for (const code of AUTHORIZATION_BLOCKED) assert.ok(ERROR_CODES[code], code);
});

test("settings state fails closed and widget exposes all required presentation states", async () => {
  const ui = await import("../.test-build/ui.mjs");
  assert.equal(ui.settingsViewState(false, true), "loading");
  assert.equal(ui.settingsViewState(true, false), "locked");
  assert.equal(ui.settingsViewState(true, true), "editable");
  assert.equal(ui.widgetViewState("available", false).state, "loading");
  assert.equal(ui.widgetViewState("available", true, { configured: false }).state, "not-set-up");
  assert.equal(ui.widgetViewState("available", true, { configured: true, enabled: true, status: "success" }).state, "healthy");
  assert.equal(ui.widgetViewState("available", true, { configured: true, enabled: true, status: "partial" }).state, "error");
  assert.equal(ui.widgetViewState("denied", true).state, "unavailable");
});
