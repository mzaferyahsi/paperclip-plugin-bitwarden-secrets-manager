import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { bitwardenSdkAdapter } from "../.test-build/bitwarden-adapter.mjs";

const fixtureToken = "fixture-bsm-token-7d91a2";
const fixtureValue = "fixture-secret-value-4c80ef";

test("native SDK Error-level capture and adapter errors do not expose fixture credentials or values", async () => {
  const child = spawnSync(process.execPath, ["tests/sdk-capture-child.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "remote_unavailable");
  for (const captured of [child.stdout, child.stderr]) {
    assert.equal(captured.includes(fixtureToken), false);
    assert.equal(captured.includes(fixtureValue), false);
  }

  const adapter = bitwardenSdkAdapter({
    secrets: () => ({
      list: async () => ({ success: false, errorMessage: `SDK rejected ${fixtureToken}; value=${fixtureValue}` }),
      getByIds: async () => ({ success: true, data: { data: [] } }),
    }),
  });
  await assert.rejects(adapter.listSecretIds("org-fixture"), (error) => {
    assert.equal(error.code, "remote_unavailable");
    assert.equal(error.message.includes(fixtureToken), false);
    assert.equal(error.message.includes(fixtureValue), false);
    return true;
  });
});

test("runtime HTTP bridge sends fixture auth/value only in the request and emits no trace or status copy", async () => {
  const ref = (id) => ({ type: "secret_ref", secretId: id, version: "latest" });
  const companyId = "company-fixture";
  const tokenRef = "550e8400-e29b-41d4-a716-446655440001";
  const apiRef = "550e8400-e29b-41d4-a716-446655440002";
  const config = {
    enabled: true, bsmAccessToken: ref(tokenRef), paperclipApiToken: ref(apiRef),
    bsmOrganizationId: "550e8400-e29b-41d4-a716-446655440003",
    bsmProjectIds: ["550e8400-e29b-41d4-a716-446655440004"],
    paperclipApiOrigin: "https://paperclip.example/", destinationScope: "company",
  };
  const calls = [];
  const state = new Map();
  const activity = [];
  const spanRecords = [];
  const ctx = {
    jobs: { register() {} }, data: { register() {} }, actions: { register(_name, handler) { ctx.resync = handler; } },
    companies: { list: async () => [{ id: companyId }], get: async () => ({ id: companyId }) },
    config: { get: async () => config },
    state: {
      get: async ({ scopeId, stateKey }) => state.get(`${scopeId}/${stateKey}`) ?? null,
      set: async ({ scopeId, stateKey }, value) => state.set(`${scopeId}/${stateKey}`, value),
    },
    secrets: { resolve: async (_ref, options) => options.configPath === "bsmAccessToken" ? fixtureToken : "fixture-paperclip-credential" },
    activity: { log: async (entry) => activity.push(entry) },
    tracer: { startSpan() { throw new Error("runtime must not create spans for HTTP payloads"); }, record: async (record) => spanRecords.push(record) },
    http: { fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(calls.length === 1 ? [] : {
        id: "550e8400-e29b-41d4-a716-446655440005", latestVersion: 1,
      }), { status: calls.length === 1 ? 200 : 201, headers: { "content-type": "application/json" } });
    } },
  };
  const { registerRuntime } = await import("../.test-build/runtime.js");
  registerRuntime(ctx, {
    createSdk: async () => ({
      listProjects: async () => [{ id: config.bsmProjectIds[0], organizationId: config.bsmOrganizationId }],
      listSecretIds: async () => [{ id: "source-uuid", organizationId: config.bsmOrganizationId }],
      getSecrets: async () => [{
        id: "source-uuid", organizationId: config.bsmOrganizationId, projectId: config.bsmProjectIds[0],
        key: "fixture", value: fixtureValue, revisionDate: "2026-10-11T00:00:00.000Z",
      }],
    }),
  });
  const result = await ctx.resync({}, { actor: { type: "user", userId: "operator" }, companyId });
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 2);
  assert.match(calls[1].init.headers.Authorization, /^Bearer fixture-paperclip-credential$/);
  assert.equal(calls[1].init.body.includes(fixtureValue), true);
  assert.deepEqual(spanRecords, []);
  const persisted = JSON.stringify({ state: [...state.values()], activity, result });
  assert.equal(persisted.includes(fixtureToken), false);
  assert.equal(persisted.includes("fixture-paperclip-credential"), false);
  assert.equal(persisted.includes(fixtureValue), false);
});
