import test from "node:test";
import assert from "node:assert/strict";
import { ALL_SECRETS_ID, NO_PROJECT_ID, normalizeSelection, selectionAdmits, validateConfig } from "../src/config.ts";
import { readBsmSnapshot, bitwardenSdkAdapter, discoverCatalogue } from "../.test-build/bitwarden-adapter.mjs";
import { registerSettingsActions } from "../.test-build/settings-actions.js";
import { registerOverviewActions, buildOverview } from "../.test-build/overview.js";
import { buildStatus } from "../.test-build/runtime.js";
import { AdapterError } from "../.test-build/adapters/types.js";
// Bundles carry separate class copies: match by name/code, as the runtime does.
import * as ui from "../.test-build/ui.mjs";

const id = (n) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, "0")}`;
const companyId = id(10), org = id(13);
const P1 = id(21), P2 = id(22), P3 = id(23);
const S1 = id(31), S2 = id(32), S3 = id(33), S4 = id(34);
const setupRef = { type: "secret_ref", secretId: id(11) }, runtimeRef = { type: "secret_ref", secretId: id(12) }, bsmRef = { type: "secret_ref", secretId: id(16), version: "latest" };
const VALUES = { [S1]: "value-one-SECRET", [S2]: "value-two-SECRET", [S3]: "value-three-SECRET", [S4]: "value-four-SECRET" };
const PROJECT_OF = { [S1]: P1, [S2]: P1, [S3]: P2, [S4]: P3 };
const valid = { enabled: true, bsmAccessToken: bsmRef, paperclipApiToken: runtimeRef, bsmOrganizationId: org, paperclipApiOrigin: "https://paperclip.example/", destinationScope: "company" };

// ---- config model ----
test("selection: all, selected and mixed projects normalize; legacy list means whole-project", () => {
  const mixed = normalizeSelection({ bsmProjectSelections: [{ projectId: P1, mode: "all" }, { projectId: P2, mode: "selected", secretIds: [S3] }] });
  assert.equal(mixed.ok, true); assert.equal(mixed.legacy, false); assert.equal(mixed.entries.length, 2);
  const legacy = normalizeSelection({ bsmProjectIds: [P1, P2] });
  assert.deepEqual(legacy, { ok: true, legacy: true, entries: [{ projectId: P1, mode: "all" }, { projectId: P2, mode: "all" }] });
  assert.equal(validateConfig({ ...valid, bsmProjectIds: [P1] }), null, "existing configs keep validating");
  assert.equal(validateConfig({ ...valid, bsmProjectSelections: mixed.entries }), null);
});

test("selection: empty, duplicate, malformed and conflicting inputs fail closed with no whole-org fallback", () => {
  const bad = (cfg, code) => assert.deepEqual(normalizeSelection(cfg), { ok: false, code }, JSON.stringify(cfg));
  bad({}, "project_allowlist_invalid");
  bad({ bsmProjectIds: [] }, "project_allowlist_invalid");
  bad({ bsmProjectIds: [P1, P1] }, "project_allowlist_invalid");
  bad({ bsmProjectIds: ["nope"] }, "project_allowlist_invalid");
  bad({ bsmProjectSelections: [] }, "project_selection_invalid");
  bad({ bsmProjectSelections: "all" }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: [] }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "selected" }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "all" }, { projectId: P1, mode: "selected", secretIds: [S1] }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: [S1, S1] }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "selected", secretIds: [S1] }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: "x", mode: "all" }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: ["x"] }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "everything" }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "all", secretIds: [S1] }] }, "project_selection_invalid");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "all" }], bsmProjectIds: [P1] }, "project_selection_conflict");
  bad({ bsmProjectSelections: [{ projectId: P1, mode: "all" }], bsmProjectIds: [] }, "project_selection_conflict");
  assert.equal(validateConfig({ ...valid, bsmProjectSelections: [] }), "project_selection_invalid");
});

test("selectionAdmits judges by the secret's actual project", () => {
  const entries = [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "all" }];
  assert.equal(selectionAdmits(entries, P1, S1), true);
  assert.equal(selectionAdmits(entries, P1, S2), false, "unselected sibling");
  assert.equal(selectionAdmits(entries, P2, S3), true, "whole project, including new secrets");
  assert.equal(selectionAdmits(entries, P3, S1), false, "selected ID that now lives in an unselected project");
  assert.equal(selectionAdmits(entries, null, S1), false);
});

// ---- snapshot / overfetch ----
function sdkFixture({ hints = true, extraRows = false } = {}) {
  const fetched = [];
  const sdk = {
    listProjects: async () => [P1, P2, P3].map((pid) => ({ id: pid, organizationId: org, name: `Name-${pid.slice(-2)}` })),
    listSecretIds: async () => Object.keys(VALUES).map((sid) => ({ id: sid, organizationId: org, ...(hints ? { projectId: PROJECT_OF[sid] } : {}) })),
    getSecrets: async (ids) => { fetched.push([...ids]); return [...ids, ...(extraRows ? [S4] : [])].map((sid) => ({ id: sid, organizationId: org, projectId: PROJECT_OF[sid], key: `KEY_${sid.slice(-2)}`, value: VALUES[sid], revisionDate: "2026-10-10T00:00:00Z" })); },
  };
  return { sdk, fetched };
}
const ids = (snapshot) => snapshot.secrets.map((s) => s.id).sort();

test("whole-project includes every secret of the project, including newly added ones", async () => {
  const { sdk } = sdkFixture();
  assert.deepEqual(ids(await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "all" }])), [S1, S2]);
  assert.deepEqual(ids(await readBsmSnapshot(sdk, org, new Set([P1]))), [S1, S2], "legacy Set form unchanged");
});

test("selected mode includes only the ticked IDs and never fetches excluded values", async () => {
  const { sdk, fetched } = sdkFixture();
  const snapshot = await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "selected", secretIds: [S1] }]);
  assert.deepEqual(ids(snapshot), [S1]);
  assert.deepEqual(fetched.flat(), [S1], "S2/S3/S4 values were never requested");
});

test("mixed: whole project P2 plus selected S1 of P1; P3 and unselected S2 excluded", async () => {
  const { sdk } = sdkFixture();
  const snapshot = await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "all" }]);
  assert.deepEqual(ids(snapshot), [S1, S3]);
  assert.equal(snapshot.secrets.some((s) => s.id === S2 || s.id === S4), false);
});

test("list metadata that carries a project filters before any value fetch", async () => {
  const { sdk, fetched } = sdkFixture({ hints: true });
  const snapshot = await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "all" }]);
  assert.deepEqual(ids(snapshot), [S1, S3]);
  assert.deepEqual(fetched.flat().sort(), [S1, S3]);
});

test("cross-project: a selected ID that lives in another unselected project is excluded", async () => {
  const { sdk } = sdkFixture();
  const snapshot = await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "selected", secretIds: [S4] }]);
  assert.deepEqual(ids(snapshot), []);
});

test("an SDK that returns rows that were not requested fails closed", async () => {
  const { sdk } = sdkFixture({ extraRows: true });
  await assert.rejects(() => readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "selected", secretIds: [S1] }]),
    (e) => e?.name === "AdapterError" && e.code === "snapshot_incomplete");
});

test("a selected project that the token cannot see fails closed with a typed code, not an empty scope", async () => {
  const { sdk } = sdkFixture();
  sdk.listProjects = async () => [{ id: P1, organizationId: org }];
  await assert.rejects(() => readBsmSnapshot(sdk, org, [{ projectId: P2, mode: "all" }]), (e) => e.code === "selected_project_missing");
  await assert.rejects(() => readBsmSnapshot(sdk, org, [{ projectId: P2, mode: "selected", secretIds: [S3] }]), (e) => e.code === "selected_project_missing");
  // "All secrets" and "No project" are not real projects: they never need to be listed.
  assert.equal((await readBsmSnapshot(sdk, org, [{ projectId: ALL_SECRETS_ID, mode: "all" }])).secrets.length, 4);
});

test("the adapter exposes no value-reading discovery path", () => {
  const adapter = bitwardenSdkAdapter({ secrets: () => ({ list: async () => ({ data: [] }), getByIds: async () => ({ data: [] }) }) });
  assert.equal(adapter.describeSecrets, undefined);
});

test("without list metadata every value is read, only admitted ones are kept, and unreadable projects are unselectable", async () => {
  const { sdk, fetched } = sdkFixture({ hints: false });
  assert.deepEqual(ids(await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "all" }])), [S1, S2]);
  assert.deepEqual(ids(await readBsmSnapshot(sdk, org, new Set([P1]))), [S1, S2]);
  assert.deepEqual(ids(await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "all" }])), [S1, S3]);
  assert.deepEqual(fetched[0].sort(), [S1, S2, S3, S4].sort(), "all values are read when the list has no project");
  const all = await readBsmSnapshot(sdk, org, [{ projectId: ALL_SECRETS_ID, mode: "all" }]);
  assert.deepEqual(ids(all), [S1, S2, S3, S4]);
  // Kept records are only the admitted ones: nothing else survives the batch.
  const kept = JSON.stringify(await readBsmSnapshot(sdk, org, [{ projectId: P1, mode: "selected", secretIds: [S1] }]));
  for (const other of ["value-two-SECRET", "value-three-SECRET", "value-four-SECRET"]) assert.equal(kept.includes(other), false);
  // No project: its own group, selectable as a whole or by id. Missing project: skipped and incomplete.
  const rows = { [S1]: null, [S2]: undefined, [S3]: P2 };
  const odd = { listSecretIds: async () => Object.keys(rows).map((sid) => ({ id: sid, organizationId: org })),
    getSecrets: async (want) => want.map((sid) => ({ id: sid, organizationId: org, ...(rows[sid] === undefined ? {} : { projectId: rows[sid] }), key: "K", value: VALUES[sid], revisionDate: "2026-10-10T00:00:00Z" })) };
  const none = await readBsmSnapshot(odd, org, [{ projectId: NO_PROJECT_ID, mode: "all" }]);
  assert.deepEqual([ids(none), none.secrets[0].projectId, none.complete, none.skippedCount], [[S1], NO_PROJECT_ID, false, 1]);
  const everything = await readBsmSnapshot(odd, org, [{ projectId: ALL_SECRETS_ID, mode: "all" }]);
  assert.deepEqual([ids(everything), everything.complete], [[S1, S3], false], "unreadable project is never guessed or synced");
});

test("discoverCatalogue groups by project, names them, adds a No project group and flags unreadable projects; values never escape", async () => {
  const rows = { [S1]: P1, [S2]: P1, [S3]: null, [S4]: undefined };
  const sdk = { listProjects: async () => [{ id: P1, organizationId: org, name: "Alpha" }, { id: P2, organizationId: org, name: "Empty" }],
    listSecretIds: async () => Object.keys(rows).map((sid) => ({ id: sid, organizationId: org })),
    getSecrets: async (want) => want.map((sid) => ({ id: sid, organizationId: org, ...(rows[sid] === undefined ? {} : { projectId: rows[sid] }), key: `KEY_${sid.slice(-2)}`, value: VALUES[sid], revisionDate: "r" })) };
  const catalogue = await discoverCatalogue(sdk, org, 2);
  assert.deepEqual(catalogue.projects, [{ id: P1, name: "Alpha", secretCount: 2 }, { id: P2, name: "Empty", secretCount: 0 }, { id: NO_PROJECT_ID, name: null, secretCount: 1 }]);
  assert.deepEqual(catalogue.secrets.map((s) => [s.id, s.projectId]), [[S1, P1], [S2, P1], [S3, NO_PROJECT_ID]]);
  assert.deepEqual(catalogue.unselectable, [{ id: S4, key: "KEY_34" }]);
  assert.equal(JSON.stringify(catalogue).includes("SECRET"), false);
  for (const row of [...catalogue.secrets, ...catalogue.unselectable]) assert.deepEqual(Object.keys(row).filter((k) => k === "value"), []);
});

// ---- settings actions ----
function harness(initial, { sdk = sdkFixture().sdk, identity = { userId: "user-a", isInstanceAdmin: true, companyIds: [companyId] } } = {}) {
  const actions = {}, writes = [], store = { config: { ...initial } }, stateMap = new Map(), sdkCalls = [];
  const ctx = {
    state: { get: async (k) => stateMap.get(k.scopeId) ?? null, set: async (k, v) => { stateMap.set(k.scopeId, v); } },
    actions: { register: (key, fn) => { actions[key] = fn; } },
    config: { get: async () => store.config },
    secrets: { resolve: async (ref, opts) => { sdkCalls.push(opts.configPath); return "fixture-token"; } },
    http: { fetch: async (url, init) => {
      const u = new URL(url), path = u.pathname;
      if (path === "/api/cli-auth/me") return Response.json(identity);
      if (path.endsWith("/config")) { const body = JSON.parse(init.body); writes.push(body.configJson); store.config = body.configJson; return Response.json({ ok: true }); }
      if (path === `/api/companies/${companyId}/secrets` && init.method === "POST") return Response.json({ id: id(15) }, { status: 201 });
      if (path === `/api/companies/${companyId}/secrets`) return Response.json([{ id: id(16), companyId, name: "Existing", key: "k", provider: "local_encrypted", status: "active" }]);
      return Response.json({}, { status: 404 });
    } },
  };
  registerSettingsActions(ctx, { createSdk: async () => sdk });
  registerOverviewActions(ctx, { createSdk: async () => sdk });
  return { actions, writes, store, stateMap, sdkCalls };
}
const stored = { enabled: false, paperclipSetupApiToken: setupRef, paperclipApiToken: runtimeRef, bsmAccessToken: bsmRef, paperclipApiOrigin: "https://paperclip.example/", bsmOrganizationId: org, destinationScope: "company", syncIntervalMinutes: 15, targetSecretKeyPrefix: "bitwarden." };
const common = { bsmOrganizationId: org, paperclipApiOrigin: "https://paperclip.example/", destinationScope: "company", syncIntervalMinutes: 15, targetSecretKeyPrefix: "bitwarden.", archiveOnRemoval: false, bitwardenRegion: "US" };
const actor = { actor: { type: "user", userId: "user-a" }, companyId };

test("save persists the canonical selection, forces sync off, and a reload returns it unchanged", async () => {
  const h = harness({ ...stored, enabled: true, bsmProjectIds: [P1] });
  const selection = [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "all" }];
  const result = await h.actions["save-settings"]({ companyId, settings: { ...common, bsmProjectSelections: selection } }, actor);
  assert.deepEqual(result, { ok: true, errorCode: null, field: null, enabled: false });
  assert.equal(h.writes[0].enabled, false);
  assert.deepEqual(h.writes[0].bsmProjectSelections, selection);
  assert.equal("bsmProjectIds" in h.writes[0], false, "legacy list is migrated away on save");
  const reload = await h.actions["get-settings"]({}, actor);
  assert.deepEqual(reload.config.bsmProjectSelections, selection);
  const overview = await h.actions["get-overview"]({}, actor);
  assert.deepEqual(overview.scope.projects.map((p) => [p.mode, p.selectedSecretCount]), [["selected", 1], ["all", undefined]]);
  assert.equal(overview.scope.legacySelection, false);
});

test("legacy config keeps working and is shown as whole-project; it is not rewritten unless saved", async () => {
  const h = harness({ ...stored, bsmProjectIds: [P1, P2] });
  const overview = await h.actions["get-overview"]({}, actor);
  assert.equal(overview.scope.legacySelection, true);
  assert.deepEqual(overview.scope.projects.map((p) => p.mode), ["all", "all"]);
  assert.equal(h.writes.length, 0);
  await h.actions["save-settings"]({ companyId, settings: { ...common, bsmProjectIds: [P1, P2] } }, actor);
  assert.deepEqual(h.writes[0].bsmProjectIds, [P1, P2], "old clients keep legacy behaviour");
  await h.actions["save-settings"]({ companyId, settings: { ...common, bsmProjectSelections: [{ projectId: P1, mode: "all" }, { projectId: P2, mode: "all" }] } }, actor);
  assert.equal("bsmProjectIds" in h.writes[1], false);
});

test("save rejects conflicting forms, empty selected lists, duplicates and malformed IDs without writing", async () => {
  const h = harness({ ...stored, bsmProjectIds: [P1] });
  const attempts = [
    [{ bsmProjectIds: [P1], bsmProjectSelections: [{ projectId: P1, mode: "all" }] }, "project_selection_conflict"],
    [{ bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: [] }] }, "project_selection_invalid"],
    [{ bsmProjectSelections: [{ projectId: P1, mode: "all" }, { projectId: P1, mode: "all" }] }, "project_selection_invalid"],
    [{ bsmProjectSelections: [{ projectId: "bad", mode: "all" }] }, "project_selection_invalid"],
    [{ bsmProjectSelections: [] }, "project_selection_invalid"],
  ];
  for (const [scope, code] of attempts) {
    const r = await h.actions["save-settings"]({ companyId, settings: { ...common, ...scope } }, actor);
    assert.deepEqual([r.ok, r.errorCode, r.field], [false, code, "bsmProjectSelections"]);
  }
  assert.equal(h.writes.length, 0);
});

test("unknown, out-of-project and unverifiable selected secret IDs are rejected before saving", async () => {
  const h = harness({ ...stored, bsmProjectIds: [P1] });
  const save = (selection) => h.actions["save-settings"]({ companyId, settings: { ...common, bsmProjectSelections: selection } }, actor);
  assert.equal((await save([{ projectId: P1, mode: "selected", secretIds: [id(99)] }])).errorCode, "secret_selection_invalid", "unknown");
  assert.equal((await save([{ projectId: P1, mode: "selected", secretIds: [S1, id(98)] }])).errorCode, "secret_selection_invalid", "unknown among known");
  assert.equal((await save([{ projectId: id(77), mode: "selected", secretIds: [S1] }])).errorCode, "project_selection_invalid", "invisible project");
  const broken = harness({ ...stored, bsmProjectIds: [P1] }, { sdk: { listSecretIds: async () => { throw new AdapterError("remote_unavailable", true); }, getSecrets: async () => [] } });
  const r = await broken.actions["save-settings"]({ companyId, settings: { ...common, bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: [S1] }] } }, actor);
  assert.equal(r.errorCode, "selection_unverified");
  assert.equal(h.writes.length + broken.writes.length, 0);
  assert.equal((await save([{ projectId: P1, mode: "selected", secretIds: [S1, S2] }])).ok, true);
});

test("save-token and select-secret both preserve the stored selection (new and legacy forms)", async () => {
  const selection = [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "all" }];
  for (const [form, expectKey] of [[{ bsmProjectSelections: selection }, "bsmProjectSelections"], [{ bsmProjectIds: [P1] }, "bsmProjectIds"]]) {
    const t = harness({ ...stored, ...form });
    const noScope = { ...common };
    assert.equal((await t.actions["save-token"]({ companyId, token: "fixture-new-token", operationId: id(40), settings: noScope }, actor)).ok, true);
    assert.deepEqual(t.writes[0][expectKey], form[expectKey]);
    assert.equal(t.writes[0].enabled, false);
    assert.equal(JSON.stringify(t.writes[0]).includes("fixture-new-token"), false);
    const s = harness({ ...stored, ...form });
    assert.equal((await s.actions["select-secret"]({ companyId, secretId: id(16), settings: noScope }, actor)).ok, true);
    assert.deepEqual(s.writes[0][expectKey], form[expectKey]);
    assert.equal(s.writes[0].enabled, false);
  }
});

test("save-token and select-secret reject a conflicting or invalid selection supplied with them", async () => {
  const h = harness({ ...stored, bsmProjectIds: [P1] });
  const conflict = { ...common, bsmProjectIds: [P1], bsmProjectSelections: [{ projectId: P1, mode: "all" }] };
  assert.equal((await h.actions["save-token"]({ companyId, token: "fixture-new-token", operationId: id(41), settings: conflict }, actor)).errorCode, "project_selection_conflict");
  assert.equal((await h.actions["select-secret"]({ companyId, secretId: id(16), settings: conflict }, actor)).errorCode, "project_selection_conflict");
  assert.equal(h.writes.length, 0);
});

test("discover-secrets returns a value-free catalogue, requires setup authority, and get-status exposes no scope detail", async () => {
  const h = harness({ ...stored, bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: [S1] }] });
  const reply = await h.actions["discover-secrets"]({}, actor);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.projects.map((p) => [p.id, p.secretCount]), [[P1, 2], [P2, 1], [P3, 1]]);
  assert.equal(reply.secrets.length, 4);
  assert.equal(JSON.stringify(reply).includes("SECRET"), false, "no value in the UI payload");
  assert.equal(JSON.stringify([...h.stateMap.values(), ...h.writes]).includes("SECRET"), false, "no value in state or config");
  const noAdmin = harness({ ...stored }, { identity: { userId: "user-a", isInstanceAdmin: false, companyIds: [companyId] } });
  assert.deepEqual([(await noAdmin.actions["discover-secrets"]({}, actor)).ok], [false]);
  const config = { ...stored, enabled: true, bsmProjectSelections: [{ projectId: P1, mode: "selected", secretIds: [S1] }, { projectId: P2, mode: "all" }] };
  const status = JSON.stringify(buildStatus(config, { status: "success", lastRunSummary: { sourceCount: 1, created: 1, rotated: 0, nativeDriftCorrected: 0, metadataUpdated: 0, unchanged: 0, archived: 0, skippedArchived: 0, failed: 0 } }));
  for (const needle of [P1, P2, S1, "Name-", "KEY_", "SECRET", "bsmProjectSelections"]) assert.equal(status.includes(needle), false, needle);
});

// ---- UI helpers ----
test("UI helpers: legacy shows as whole-project; project, secret and all-secrets toggles keep the contract", () => {
  assert.deepEqual(ui.selectionsFromConfig({ bsmProjectIds: [P1] }), { entries: [{ projectId: P1, mode: "all" }], legacy: true });
  assert.equal(ui.selectionValid([]), false);
  let e = ui.toggleSecret([], P1, S1);
  assert.deepEqual(e, [{ projectId: P1, mode: "selected", secretIds: [S1] }]);
  e = ui.toggleSecret(e, P1, S2);
  assert.deepEqual(e[0].secretIds, [S1, S2]);
  e = ui.toggleSecret(ui.toggleSecret(e, P1, S1), P1, S2);
  assert.deepEqual(e, [], "unticking the last secret drops the entry");
  e = ui.toggleProject(ui.toggleSecret([], P1, S1), P1);
  assert.deepEqual(e, [{ projectId: P1, mode: "all" }], "whole project replaces its individual picks");
  assert.deepEqual(ui.toggleSecret(e, P1, S2), e, "secrets of a whole project are locked on");
  assert.equal(ui.secretChecked(e, P1.toUpperCase(), S2), true);
  e = ui.toggleSecret(e.concat(), P2, S3);
  assert.equal(ui.selectionValid(e), true, "mixed: a whole project plus an extra individual secret");
  assert.deepEqual(ui.toggleProject(e, P1), [{ projectId: P2, mode: "selected", secretIds: [S3] }]);
  const all = ui.setAllSecrets(e, true);
  assert.deepEqual([ui.allSecretsSelected(all), ui.selectionValid(all)], [true, true]);
  assert.deepEqual(ui.toggleProject(all, P1), all, "nothing toggles while All secrets is on");
  assert.deepEqual(ui.setAllSecrets(all, false), []);
  assert.equal(ui.selectionValid([...all, { projectId: P1, mode: "all" }]), false, "All secrets cannot mix with other entries");
  assert.deepEqual(ui.copyCoverage(), []);
});

const CATALOGUE = {
  projects: [{ id: P1, name: "Alpha", secretCount: 2 }, { id: P2, name: null, secretCount: 1 }, { id: NO_PROJECT_ID, name: null, secretCount: 1 }],
  secrets: [{ id: S1, key: "A_ONE", projectId: P1 }, { id: S2, key: "A_TWO", projectId: P1 }, { id: S3, key: "B_ONE", projectId: P2 }, { id: S4, key: "LOOSE", projectId: NO_PROJECT_ID }],
  unselectable: [{ id: id(35), key: "MYSTERY" }],
};
test("selection summary counts secrets and projects against the catalogue", () => {
  assert.deepEqual(ui.selectionSummary([], CATALOGUE), { secrets: 0, projects: 0, unknown: 0 });
  assert.deepEqual(ui.selectionSummary([{ projectId: P1, mode: "all" }, { projectId: P2, mode: "selected", secretIds: [S3, id(99)] }], CATALOGUE), { secrets: 3, projects: 2, unknown: 1 });
  assert.deepEqual(ui.selectionSummary([{ projectId: NO_PROJECT_ID, mode: "selected", secretIds: [S4] }], CATALOGUE), { secrets: 1, projects: 1, unknown: 0 });
  assert.deepEqual(ui.selectionSummary(ui.setAllSecrets([], true), CATALOGUE), { secrets: 4, projects: 3, unknown: 0 });
  assert.deepEqual(ui.selectionSummary([{ projectId: P1, mode: "all" }], null), { secrets: null, projects: null, unknown: 0 });
});

test("grouped tree: collapsible groups, counts, key names only, a No project group and an unselectable note", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = (await import("react")).default;
  const render = (entries) => renderToStaticMarkup(React.createElement(ui.SecretTree, { catalogue: CATALOGUE, entries, onChange() {} }));
  const html = render([{ projectId: P1, mode: "all" }, { projectId: NO_PROJECT_ID, mode: "selected", secretIds: [S4] }]);
  assert.match(html, /Alpha/); assert.match(html, /No project/); assert.match(html, /Project 550e8400/);
  assert.match(html, /2 secrets · 2 selected/); assert.match(html, /1 secret · 1 selected/);
  assert.match(html, /aria-expanded="false"/); assert.match(html, /aria-controls="secrets-/);
  assert.match(html, /hidden=""/, "groups start collapsed");
  assert.match(html, /A_ONE/); assert.match(html, /LOOSE/);
  assert.match(html, /Whole project selected, including secrets added to it later/);
  assert.match(html, /1 secret cannot be selected/); assert.match(html, /MYSTERY/);
  assert.match(html, /disabled=""[^>]*\/?>/, "secrets of a whole project are locked");
  for (const v of Object.values(VALUES)) assert.equal(html.includes(v), false);
});

// ---- QA contract blocker (reproduction) ----
test("QA blocker: a loopback http origin is rejected by shipped origin validation, as required for production", async () => {
  const qa = "http://127.0.0.1:3199";
  assert.equal(validateConfig({ ...valid, bsmProjectIds: [P1], paperclipApiOrigin: qa }), "paperclip_origin_invalid");
  assert.equal(validateConfig({ ...valid, bsmProjectIds: [P1], paperclipApiOrigin: qa + "/" }), "paperclip_origin_invalid");
  const h = harness({ ...stored, paperclipApiOrigin: qa, bsmProjectIds: [P1] });
  const r = await h.actions["get-settings"]({}, actor);
  assert.deepEqual([r.ok, r.errorCode], [false, "paperclip_origin_invalid"]);
});

// ---- Manual secret-ID selection (ALR-1545) ----
test("UI copy: new codes are covered and plain; the old limitation text is gone", () => {
  assert.match(ui.errorCopy("selected_project_missing").action, /Nothing was synced or removed/);
  assert.equal(ui.errorCopy("secret_limit_exceeded").title, "Something went wrong", "the 500 cap is retired");
  assert.equal(ui.errorCopy("project_membership_unavailable").title, "Something went wrong", "retired code");
  assert.deepEqual(ui.copyCoverage(), []);
});