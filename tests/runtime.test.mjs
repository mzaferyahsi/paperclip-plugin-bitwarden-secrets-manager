import test from "node:test";
import assert from "node:assert/strict";
import { registerRuntime } from "../.test-build/runtime.js";

const ref = (n) => ({ type: "secret_ref", secretId: `550e8400-e29b-41d4-a716-44665544000${n}`, version: "latest" });
const config = (enabled = true) => ({
  enabled, bsmAccessToken: ref(0), paperclipApiToken: ref(1),
  bsmOrganizationId: "550e8400-e29b-41d4-a716-446655440002",
  bsmProjectIds: ["550e8400-e29b-41d4-a716-446655440003"],
  paperclipApiOrigin: "https://paperclip.example/", destinationScope: "company",
});
function fakeContext(companyConfigs, seeded = {}, resolveImpl = async () => "fixture-secret-value") {
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
    config: { get: async (companyId) => companyConfigs[companyId] ?? {} },
    state: {
      get: async ({ scopeId, stateKey }) => state.get(`${scopeId}/${stateKey}`) ?? null,
      set: async ({ scopeId, stateKey }, value) => state.set(`${scopeId}/${stateKey}`, value),
    },
    secrets: { resolve: async (secretRef, options) => { resolved.push({ secretRef, options }); return resolveImpl(secretRef, options); } },
    activity: { log: async () => {} },
  };
  registerRuntime(ctx);
  return { handlers, state, resolved };
}

test("scheduled job enumerates companies and resolves refs with company and config path", async () => {
  const { handlers, resolved, state } = fakeContext({ companyA: config(), companyB: config(false) });
  await handlers.jobs["bsm-sync"]({ jobKey: "bsm-sync", runId: "run", trigger: "schedule", scheduledAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((x) => x.options), [
    { companyId: "companyA", configPath: "bsmAccessToken" },
    { companyId: "companyA", configPath: "paperclipApiToken" },
  ]);
  assert.equal(state.get("companyA/runtime").status, "credentials_ready");
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
  assert.equal(resolved.length, 1);
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
