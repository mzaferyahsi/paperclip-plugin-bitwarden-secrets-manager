import test from "node:test";
import assert from "node:assert/strict";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { registerRuntime } from "../.test-build/runtime.js";

const ref = (n) => ({ type: "secret_ref", secretId: `550e8400-e29b-41d4-a716-44665544000${n}`, version: "latest" });
const config = (enabled = true) => ({
  enabled, bsmAccessToken: ref(0), paperclipApiToken: ref(1),
  bsmOrganizationId: "550e8400-e29b-41d4-a716-446655440002",
  bsmProjectIds: ["550e8400-e29b-41d4-a716-446655440003"],
  paperclipApiOrigin: "https://paperclip.example/", destinationScope: "company",
});
function fakeContext(companyConfigs, seeded = {}, resolveImpl = async () => "fixture-secret-value", denyConfig = [], failConfig = []) {
  const logged = [];
  const infos = [];
  const warns = [];
  const handlers = { jobs: {}, data: {}, actions: {} };
  const state = new Map(Object.entries(seeded).map(([companyId, value]) => [`${companyId}/runtime`, value]));
  const resolved = [];
  const ctx = {
    jobs: { register: (key, fn) => { handlers.jobs[key] = fn; } },
    data: { register: (key, fn) => { handlers.data[key] = fn; } },
    actions: { register: (key, fn) => { handlers.actions[key] = fn; } },
    companies: {
      list: async () => Object.keys(companyConfigs).map((id) => ({ id })),
      get: async (id) => companyConfigs[id] ? { id } : null,
    },
    config: { get: async (companyId) => {
      if (denyConfig.includes(companyId)) throw new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED, message: "company context is required" });
      if (failConfig.includes(companyId)) throw new Error("boom");
      return companyConfigs[companyId] ?? {};
    } },
    state: {
      get: async ({ scopeId, stateKey }) => state.get(`${scopeId}/${stateKey}`) ?? null,
      set: async ({ scopeId, stateKey }, value) => state.set(`${scopeId}/${stateKey}`, value),
    },
    secrets: { resolve: async (secretRef, options) => { resolved.push({ secretRef, options }); return resolveImpl(secretRef, options); } },
    activity: { log: async () => {} },
    logger: { error: (message, meta) => { logged.push({ message, meta }); }, info: (message, meta) => { infos.push({ message, meta }); }, warn: (message, meta) => { warns.push({ message, meta }); }, debug() {} },
  };
  registerRuntime(ctx, {
    createSdk: async () => ({ listSecretIds: async () => [], getSecrets: async () => [] }),
    createTransport: () => async () => ({ status: 200, json: async () => [] }),
  });
  return { handlers, state, resolved, logged, infos, warns };
}

test("scheduled job enumerates companies and resolves refs with company and config path", async () => {
  const { handlers, resolved, state } = fakeContext({ companyA: config(), companyB: config(false) });
  await handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((x) => x.options), [
    { companyId: "companyA", configPath: "bsmAccessToken" },
    { companyId: "companyA", configPath: "paperclipApiToken" },
  ]);
  assert.equal(state.get("companyA/runtime").status, "success");
  assert.equal(state.has("companyB/runtime"), false);
  assert.equal(JSON.stringify([...state.values()]).includes("fixture-secret-value"), false);
});

test("scheduledAt cadence skips early ticks without moving the anchor", async () => {
  const priorNow = Date.now;
  Date.now = () => Date.parse("2026-01-01T00:10:00.000Z");
  try {
    const seeded = { companyA: { generation: 1, scheduledAnchor: "2026-01-01T00:00:00.000Z" } };
    const { handlers, resolved, state } = fakeContext({ companyA: config() }, seeded);
    await handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:10:00.000Z" });
    assert.equal(resolved.length, 0);
    assert.equal(state.get("companyA/runtime").scheduledAnchor, "2026-01-01T00:00:00.000Z");
    assert.equal(state.get("companyA/runtime").status, "skipped_early_tick");
  } finally { Date.now = priorNow; }
});

test("backwards clock beyond one interval resets cadence anchor with a sanitized warning", async () => {
  const priorNow = Date.now;
  Date.now = () => Date.parse("2026-01-01T00:00:00.000Z");
  try {
    const seeded = { companyA: { generation: 1, scheduledAnchor: "2026-01-02T00:00:00.000Z" } };
    const { handlers, resolved, state } = fakeContext({ companyA: config() }, seeded);
    await handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(resolved.length, 2);
    assert.equal(state.get("companyA/runtime").warningCode, "clock_anchor_reset");
    assert.equal(state.get("companyA/runtime").scheduledAnchor, "2026-01-01T00:00:00.000Z");
  } finally { Date.now = priorNow; }
});

test("a second entry point returns already_running while the first run still holds the mutex", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { handlers, resolved } = fakeContext({ companyA: config() }, {}, async () => gate);
  const scheduled = handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "manual", scheduledAt: new Date().toISOString() });
  await new Promise((resolve) => setImmediate(resolve));
  const action = await handlers.actions.resync({}, { actor: { type: "user", userId: "user", companyId: "companyA" }, companyId: "companyA" });
  assert.deepEqual(action, { status: "already_running" });
  assert.equal(resolved.length, 2);
  release("credential");
  await scheduled;
});

test("status action uses host-authorized company scope and rejects agent actors", async () => {
  const { handlers, state } = fakeContext({ companyA: config(), companyB: config() }, {
    companyA: { status: "ready" }, companyB: { status: "private" },
  });
  assert.deepEqual(await handlers.actions["get-status"]({}, { actor: { type: "agent", userId: null }, companyId: "companyB" }), { status: "denied", errorCode: "user_context_required" });
  const result = await handlers.actions["get-status"]({}, { actor: { type: "user", userId: "user" }, companyId: "companyA" });
  assert.equal(result.status, "ready");
  assert.notEqual(result.status, state.get("companyB/runtime").status);
});

test("a company the host denies config.get for is skipped and does not abort the tick", async () => {
  const { handlers, resolved, state } = fakeContext(
    { unconfigured: {}, companyA: config() }, {}, undefined, ["unconfigured"]);
  await handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(state.has("unconfigured/runtime"), false);
  assert.equal(state.get("companyA/runtime").status, "success");
  assert.equal(resolved.length, 2);
});

test("an unexpected config.get error is logged with the company id and rethrown", async () => {
  const { handlers, logged } = fakeContext(
    { broken: config(), companyA: config() }, {}, undefined, [], ["broken"]);
  await assert.rejects(
    handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:00:00.000Z" }),
    /boom/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].meta.companyId, "broken");
  assert.equal(JSON.stringify(logged).includes("fixture-secret-value"), false);
});

test("a configured company is processed while an unconfigured company is denied in the same tick", async () => {
  const { handlers, state, infos } = fakeContext({ companyA: config(), companyB: {} }, {}, undefined, ["companyB"]);
  await handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(state.get("companyA/runtime").status, "success");
  assert.equal(state.has("companyB/runtime"), false);
  assert.deepEqual(infos.at(-1).meta, { companies: 2, configured: 1, enabled: 1, denied: 1, processed: 1 });
});

test("a tick where the host denies config.get for every company logs a warning instead of a plain summary", async () => {
  const { handlers, warns, infos } = fakeContext({ companyA: config(), companyB: config() }, {}, undefined, ["companyA", "companyB"]);
  await handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(warns.length, 1);
  assert.equal(warns[0].meta.denied, 2);
  assert.equal(infos.length, 0);
});
