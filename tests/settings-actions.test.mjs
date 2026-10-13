import test from "node:test";
import assert from "node:assert/strict";
import { registerSettingsActions } from "../.test-build/settings-actions.js";

const companyId = "550e8400-e29b-41d4-a716-446655440010";
const setupRef = { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440011" };
const runtimeRef = { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440012" };
const fixtureToken = "fixture-bsm-token-never-return-this";
const baseConfig = {
  enabled: false, paperclipSetupApiToken: setupRef, paperclipApiToken: runtimeRef,
  paperclipApiOrigin: "https://paperclip.example/",
  bsmOrganizationId: "550e8400-e29b-41d4-a716-446655440013",
  bsmProjectIds: ["550e8400-e29b-41d4-a716-446655440014"],
  destinationScope: "company", syncIntervalMinutes: 15, targetSecretKeyPrefix: "bitwarden.",
};
const actorContext = { actor: { type: "user", userId: "user-a" }, companyId };
const settings = {
  bsmOrganizationId: baseConfig.bsmOrganizationId, bsmProjectIds: baseConfig.bsmProjectIds,
  paperclipApiOrigin: baseConfig.paperclipApiOrigin, destinationScope: "company",
  syncIntervalMinutes: 15, targetSecretKeyPrefix: "bitwarden.", archiveOnRemoval: false, bitwardenRegion: "US",
};

function harness(identity = { userId: "user-a", isInstanceAdmin: true, companyIds: [companyId] }, behavior = {}) {
  const actions = {};
  const config = { [companyId]: { ...baseConfig } };
  const requests = [];
  const ctx = {
    actions: { register: (key, fn) => { actions[key] = fn; } },
    config: { get: async (id) => config[id] ?? {} },
    secrets: { resolve: async (ref, opts) => {
      assert.deepEqual(opts, { companyId, configPath: "paperclipSetupApiToken" });
      assert.deepEqual(ref, setupRef);
      return "fixture-paperclip-setup-credential";
    } },
    http: { fetch: async (url, init) => {
      const parsed = new URL(url);
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ path: parsed.pathname, method: init.method ?? "GET", body });
      if (parsed.pathname === "/api/cli-auth/me") return Response.json(identity);
      if (parsed.pathname === `/api/companies/${companyId}/secrets` && init.method === "POST") {
        if (behavior.permissionDenied) return Response.json({ error: "denied" }, { status: 403 });
        if (behavior.loseCreateResponse) return Response.json({ error: "temporary" }, { status: 500 });
        return Response.json({ id: "550e8400-e29b-41d4-a716-446655440015" }, { status: 201 });
      }
      if (parsed.pathname === `/api/companies/${companyId}/secrets`) return Response.json([
        { id: "550e8400-e29b-41d4-a716-446655440016", companyId, name: "Imported value", key: "existing.key", provider: "vault-managed", status: "active" },
        ...(behavior.loseCreateResponse ? [{ id: "550e8400-e29b-41d4-a716-446655440015", companyId, name: "Recovered bootstrap", key: "bitwarden.bootstrap.mzaferyahsi.bitwarden-secrets-manager-sync.550e8400-e29b-41d4-a716-446655440017", provider: "local_encrypted", status: "active" }] : []),
      ]);
      if (parsed.pathname === "/api/plugins/mzaferyahsi.bitwarden-secrets-manager-sync/config" && init.method === "POST") {
        config[companyId] = body.configJson;
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } },
  };
  registerSettingsActions(ctx);
  return { actions, config, requests };
}

test("Enter token stores a native encrypted secret and config contains only its ref", async () => {
  const { actions, config, requests } = harness();
  const result = await actions["save-token"]({ companyId, token: fixtureToken, operationId: "550e8400-e29b-41d4-a716-446655440017", settings }, actorContext);
  assert.equal(result.ok, true);
  const create = requests.find((request) => request.method === "POST" && request.path.endsWith("/secrets"));
  assert.equal(create.body.provider, "local_encrypted");
  assert.equal(create.body.managedMode, "paperclip_managed");
  assert.equal(create.body.value, fixtureToken);
  const saved = requests.find((request) => request.path.endsWith("/config"));
  assert.deepEqual(saved.body.configJson.bsmAccessToken, { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440015", version: "latest" });
  assert.equal(saved.body.configJson.enabled, false);
  assert.equal(JSON.stringify(saved.body).includes(fixtureToken), false);
  assert.equal(JSON.stringify(result).includes(fixtureToken), false);
  assert.equal(config[companyId].bsmAccessToken.secretId, "550e8400-e29b-41d4-a716-446655440015");
});

test("Select existing accepts a provider-agnostic active secret and saves only its ref", async () => {
  const { actions, requests } = harness();
  const result = await actions["select-secret"]({ companyId, secretId: "550e8400-e29b-41d4-a716-446655440016", settings }, actorContext);
  assert.equal(result.ok, true);
  assert.equal(result.secret.provider, "vault-managed");
  assert.deepEqual(requests.find((request) => request.path.endsWith("/config")).body.configJson.bsmAccessToken,
    { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440016", version: "latest" });
  assert.equal(requests.some((request) => request.path.includes("/resolve") || request.path.includes("/value")), false);
});

test("identity mismatch prevents all secret and config writes and never echoes the input token", async () => {
  const { actions, requests } = harness({ userId: "different-user", isInstanceAdmin: true, companyIds: [companyId] });
  const result = await actions["save-token"]({ companyId, token: fixtureToken, operationId: "550e8400-e29b-41d4-a716-446655440018", settings }, actorContext);
  assert.deepEqual(result, { ok: false, errorCode: "setup_identity_mismatch" });
  assert.equal(requests.some((request) => request.path.endsWith("/secrets") || request.path.endsWith("/config")), false);
  assert.equal(JSON.stringify(result).includes(fixtureToken), false);
});

test("the page cannot override the host-authorized company ID", async () => {
  const { actions, requests } = harness();
  const result = await actions["list-secrets"]({ companyId: "550e8400-e29b-41d4-a716-446655440099" }, actorContext);
  assert.deepEqual(result, { ok: false, errorCode: "user_context_required" });
  assert.equal(requests.length, 0);
});

test("permission denial stops without retrying or exposing the entered token", async () => {
  const { actions, requests } = harness(undefined, { permissionDenied: true });
  const result = await actions["save-token"]({ companyId, token: fixtureToken, operationId: "550e8400-e29b-41d4-a716-446655440017", settings }, actorContext);
  assert.deepEqual(result, { ok: false, errorCode: "setup_permission_denied" });
  assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/secrets")).length, 1);
  assert.equal(requests.some((request) => request.path.endsWith("/config")), false);
  assert.equal(JSON.stringify(result).includes(fixtureToken), false);
});

test("lost secret-create response is reconciled by deterministic operation key", async () => {
  const { actions, requests } = harness(undefined, { loseCreateResponse: true });
  const result = await actions["save-token"]({ companyId, token: fixtureToken, operationId: "550e8400-e29b-41d4-a716-446655440017", settings }, actorContext);
  assert.equal(result.ok, true);
  assert.equal(requests.filter((request) => request.method === "POST" && request.path.endsWith("/secrets")).length, 1);
  assert.equal(requests.filter((request) => request.method === "GET" && request.path.endsWith("/secrets")).length, 1);
  assert.equal(JSON.stringify(result).includes(fixtureToken), false);
});

test("save-settings keeps the existing token ref, stays disabled, and requires a token ref", async () => {
  const bsmRef = { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440016", version: "latest" };
  const h = harness();
  h.config[companyId] = { ...baseConfig, enabled: true, bsmAccessToken: bsmRef };
  const result = await h.actions["save-settings"]({ companyId, settings: { ...settings, syncIntervalMinutes: 30 } }, actorContext);
  assert.equal(result.ok, true);
  const saved = h.requests.find((r) => r.path.endsWith("/config")).body.configJson;
  assert.deepEqual(saved.bsmAccessToken, bsmRef);
  assert.equal(saved.enabled, false);
  assert.equal(saved.syncIntervalMinutes, 30);
  const none = harness();
  assert.deepEqual(await none.actions["save-settings"]({ companyId, settings }, actorContext), { ok: false, errorCode: "bsm_credential_required" });
});

test("replacing the token creates a new secret and switches the ref", async () => {
  const h = harness();
  h.config[companyId] = { ...baseConfig, bsmAccessToken: { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440016" } };
  const result = await h.actions["save-token"]({ companyId, token: fixtureToken, operationId: "550e8400-e29b-41d4-a716-446655440017", settings }, actorContext);
  assert.equal(result.ok, true);
  assert.equal(h.config[companyId].bsmAccessToken.secretId, "550e8400-e29b-41d4-a716-446655440015");
  assert.equal(h.requests.some((r) => r.method === "DELETE"), false);
});
