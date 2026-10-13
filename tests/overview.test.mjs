import test from "node:test";
import assert from "node:assert/strict";
import { buildOverview, registerOverviewActions } from "../.test-build/overview.js";
import { describeCode } from "../.test-build/messages.js";

const companyId = "550e8400-e29b-41d4-a716-446655440010";
const ref = (n) => ({ type: "secret_ref", secretId: `550e8400-e29b-41d4-a716-44665544002${n}` });
const org = "550e8400-e29b-41d4-a716-446655440013";
const project = "550e8400-e29b-41d4-a716-446655440014";
const full = { enabled: true, bsmAccessToken: ref(1), paperclipApiToken: ref(2), bsmOrganizationId: org, bsmProjectIds: [project], paperclipApiOrigin: "https://paperclip.example/", bitwardenRegion: "EU", syncIntervalMinutes: 15 };
const user = { actor: { type: "user", userId: "u" }, companyId };

function harness(config, state = {}, sdk) {
  const actions = {}; const store = new Map([[`${companyId}/runtime`, state]]); const resolved = [];
  const ctx = {
    actions: { register: (k, f) => { actions[k] = f; } },
    config: { get: async () => config },
    state: { get: async ({ scopeId, stateKey }) => store.get(`${scopeId}/${stateKey}`) ?? null, set: async ({ scopeId, stateKey }, v) => { store.set(`${scopeId}/${stateKey}`, v); } },
    secrets: { resolve: async (r, o) => { resolved.push(o); return "fixture-bsm-token-value"; } },
  };
  registerOverviewActions(ctx, { createSdk: async () => sdk });
  return { actions, store, resolved };
}

test("overview reports disabled state with the reason and never any ref ids or values", () => {
  const o = buildOverview({ ...full, enabled: false }, {});
  assert.equal(o.status, "disabled");
  assert.match(o.reason.action, /Enabled/);
  assert.deepEqual(o.credentials, { bitwardenToken: true, paperclipToken: true, paperclipSetupToken: false });
  assert.equal(JSON.stringify(o).includes(full.bsmAccessToken.secretId), false);
});

test("missing token maps to a plain-language action, not a raw code", () => {
  const { bsmAccessToken, ...rest } = full;
  const o = buildOverview(rest, {});
  assert.equal(o.status, "setup_needed");
  assert.equal(o.reason.action, "Add the Bitwarden machine access token below and save.");
  assert.equal(o.checklist.find((c) => c.id === "bsm-token").done, false);
});

test("last sync, counts, duration and next run are reported; blocked credential states stop scheduling", () => {
  const counts = { read: 3, created: 1, updated: 1, unchanged: 1, archived: 0, failed: 0 };
  const now = Date.parse("2026-01-01T00:10:00Z");
  const ok = buildOverview(full, { status: "success", lastAttemptAt: "2026-01-01T00:05:00Z", lastSuccessAt: "2026-01-01T00:05:00Z", scheduledAnchor: "2026-01-01T00:05:00Z", counts, lastDurationMs: 1200 }, now);
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.lastSync.counts, counts);
  assert.equal(ok.lastSync.durationMs, 1200);
  assert.equal(ok.nextRunAt, "2026-01-01T00:20:00.000Z");
  const blocked = buildOverview(full, { status: "configuration_required", errorCode: "paperclip_credential_expired_or_revoked" }, now);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.nextRunAt, null);
  assert.match(blocked.error.action, /instance admin/);
  assert.equal(describeCode("unknown_code_x").message, "An unexpected problem occurred.");
});

test("get-overview requires a user context and returns only non-secret settings", async () => {
  const { actions } = harness(full);
  assert.equal((await actions["get-overview"]({}, { actor: { type: "agent", userId: null }, companyId })).ok, false);
  const result = await actions["get-overview"]({}, user);
  assert.equal(result.ok, true);
  assert.equal(result.config.bsmOrganizationId, org);
  assert.equal(JSON.stringify(result).includes(full.bsmAccessToken.secretId), false);
});

test("test-connection reports visible projects and secret count, caches project names, never returns the token", async () => {
  const sdk = {
    listProjects: async () => [{ id: project, organizationId: org, name: "Prod" }, { id: "550e8400-e29b-41d4-a716-446655440099", organizationId: org, name: "Other" }],
    listSecretIds: async () => [{ id: "a", organizationId: org }, { id: "b", organizationId: org }, { id: "c", organizationId: "other" }],
    getSecrets: async () => [],
  };
  const { actions, store, resolved } = harness(full, {}, sdk);
  const r = await actions["test-connection"]({}, user);
  assert.equal(r.ok, true);
  assert.equal(r.projectCount, 2); assert.equal(r.secretCount, 2);
  assert.deepEqual(r.missingProjectIds, []);
  assert.deepEqual(resolved, [{ companyId, configPath: "bsmAccessToken" }]);
  assert.equal(store.get(`${companyId}/runtime`).projectNames[project], "Prod");
  assert.equal(JSON.stringify(r).includes("fixture-bsm-token-value"), false);
  assert.equal(buildOverview(full, store.get(`${companyId}/runtime`)).scope.projects[0].name, "Prod");
});

test("test-connection maps auth failures and missing token to guided messages", async () => {
  const { AdapterError } = await import("../.test-build/adapters/types.js");
  const bad = harness(full, {}, { listProjects: async () => { throw new AdapterError("configuration_required"); }, listSecretIds: async () => [], getSecrets: async () => [] });
  const r = await bad.actions["test-connection"]({}, user);
  assert.equal(r.ok, false);
  assert.match(r.error.action, /Replace the Bitwarden machine access token/);
  const { bsmAccessToken, ...rest } = full;
  const none = await harness(rest).actions["test-connection"]({}, user);
  assert.equal(none.errorCode, "bsm_credential_required");
});
