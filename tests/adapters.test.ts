import test from "node:test";
import assert from "node:assert/strict";
import { bitwardenSdkAdapter, readBsmSnapshot } from "../src/adapters/bitwarden.js";
import {
  AdapterError, type BsmSecret, type HttpRequest, type HttpResponse, type NativeSecret,
} from "../src/adapters/types.js";
import {
  PaperclipSecretsAdapter, assertSetupIdentity, createBootstrapTokenSecret, listSelectableSecrets, savePluginConfig,
} from "../src/adapters/paperclip.js";

const source: BsmSecret = {
  id: "source-1", organizationId: "org-1", projectId: "project-1", key: "API_KEY",
  value: "fixture-value", revisionDate: "2026-10-10T12:00:00Z",
};
const actor = { type: "user" as const, userId: "user-1", companyId: "company-1" };
const identity = { userId: "user-1", isInstanceAdmin: true, companyIds: ["company-1"] };
const metadata = {
  source: "bitwarden_secrets_manager" as const, syncOwner: "mzaferyahsi.bitwarden-secrets-manager-sync" as const,
  bsmOrganizationId: "org-1", bsmSecretId: "source-1", bsmProjectId: "project-1",
  sourceRevision: source.revisionDate, identityVersion: 1 as const,
};

function reply(status = 200, value: unknown = {}): HttpResponse {
  return { status, json: async () => value };
}

test("BWSM snapshot fetches complete selected values and rejects partial batches", async () => {
  const sdk = {
    listSecretIds: async () => [{ id: source.id, organizationId: source.organizationId, projectId: source.projectId }],
    getSecrets: async (ids: readonly string[]) => ids.map(() => source),
  };
  const snapshot = await readBsmSnapshot(sdk, "org-1", new Set(["project-1"]));
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.secrets, [source]);
  const wrapped = bitwardenSdkAdapter({ secrets: () => ({
    list: async () => [{ id: source.id, organizationId: source.organizationId, projectId: source.projectId }],
    getByIds: async () => [source],
  }) });
  assert.deepEqual((await readBsmSnapshot(wrapped, "org-1", new Set(["project-1"]))).secrets, [source]);
  await assert.rejects(() => readBsmSnapshot({ ...sdk, getSecrets: async () => [] }, "org-1", new Set(["project-1"])),
    (error: unknown) => error instanceof AdapterError && error.code === "snapshot_incomplete");
});

test("native create, token-secret create and plugin config save use exact contracts", async () => {
  const calls: HttpRequest[] = [];
  const transport = async (call: HttpRequest) => {
    calls.push(call);
    if (call.method === "GET") return reply(200, [{ id: "native-1", name: "Fixture", key: "owned", companyId: "company-1", status: "active" }]);
    return reply(200, { id: "native-1", name: "Fixture", key: "bitwarden.bootstrap.op", companyId: "company-1" });
  };
  const adapter = new PaperclipSecretsAdapter(transport, "company-1");
  await adapter.create({ name: "Secret · source-1", key: "bitwarden.org-1.source-1", provider: "local_encrypted",
    managedMode: "paperclip_managed", value: "fixture-value", providerMetadata: metadata });
  await createBootstrapTokenSecret(transport, actor, identity, {
    name: "Bitwarden token", key: "bitwarden.bootstrap.plugin.op", value: "fixture-token",
  });
  await savePluginConfig(transport, actor, identity, "plugin-id", { enabled: false },
    { type: "secret_ref", secretId: "native-1", version: "latest" });
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", "/api/companies/company-1/secrets"],
    ["POST", "/api/companies/company-1/secrets"],
    ["GET", "/api/companies/company-1/secrets"],
    ["POST", "/api/plugins/plugin-id/config"],
  ]);
  assert.deepEqual(calls[1].body, {
    name: "Bitwarden token", key: "bitwarden.bootstrap.plugin.op", provider: "local_encrypted",
    managedMode: "paperclip_managed", value: "fixture-token",
  });
  assert.deepEqual(calls[3].body, {
    companyId: "company-1", configJson: { enabled: false, bsmAccessToken: { type: "secret_ref", secretId: "native-1", version: "latest" } },
  });
});

test("config save validates active same-company native refs and picker rows fail closed", async () => {
  const ref = { type: "secret_ref" as const, secretId: "native-1", version: "latest" as const };
  for (const rows of [
    [{ id: "native-1", name: "Foreign", key: "k", companyId: "other-company", status: "active" }],
    [{ id: "native-1", name: "Archived", key: "k", companyId: "company-1", status: "archived" }],
    [],
  ]) {
    const calls: HttpRequest[] = [];
    await assert.rejects(() => savePluginConfig(async call => {
      calls.push(call);
      return reply(200, rows);
    }, actor, identity, "plugin-id", {}, ref),
    (error: unknown) => error instanceof AdapterError && error.code === "ownership_mismatch");
    assert.deepEqual(calls.map(call => call.method), ["GET"]);
  }
  for (const malformed of [
    [{ id: "native-1", key: "k", companyId: "company-1", status: "active" }],
    [{ id: "native-1", name: "Nameless status", key: "k", companyId: "company-1" }],
  ]) {
    await assert.rejects(() => listSelectableSecrets(async () => reply(200, malformed), actor, identity),
      (error: unknown) => error instanceof AdapterError && error.code === "snapshot_incomplete");
  }
});

test("setup identity mismatch refuses before any request", async () => {
  await assert.rejects(() => assertSetupIdentity(actor, { ...identity, userId: "other-user" }),
    (error: unknown) => error instanceof AdapterError && error.code === "identity_mismatch");
});

test("Paperclip status errors are distinct and ambiguous writes are typed", async () => {
  for (const [status, code] of [[401, "paperclip_credential_expired_or_revoked"], [403, "paperclip_permission_denied"], [429, "paperclip_rate_limited"]] as const) {
    const adapter = new PaperclipSecretsAdapter(async () => reply(status), "company-1");
    await assert.rejects(() => adapter.list(), (error: unknown) => error instanceof AdapterError && error.code === code);
  }
  const ambiguous = new PaperclipSecretsAdapter(async () => { throw new Error("sensitive response body"); }, "company-1");
  await assert.rejects(() => ambiguous.create({ name: "Fixture", key: "bitwarden.org-1.source-1", provider: "local_encrypted",
    managedMode: "paperclip_managed", value: "fixture-value", providerMetadata: metadata }),
    (error: unknown) => error instanceof AdapterError && error.code === "ambiguous_write" && !error.message.includes("sensitive"));
});

test("PATCH is allowlisted and adapter never issues DELETE or sends key/deleted", async () => {
  const calls: HttpRequest[] = [];
  const native: NativeSecret = { id: "native-1", companyId: "company-1", name: "Fixture", key: "owned-key", status: "active", providerMetadata: metadata };
  const adapter = new PaperclipSecretsAdapter(async call => {
    calls.push(call);
    return reply(200, call.method === "GET" ? [native] : native);
  }, "company-1");
  await adapter.list();
  await adapter.updateMetadata("native-1", "Renamed", metadata);
  await adapter.archive("native-1");
  await adapter.reactivate("native-1");
  for (const call of calls) {
    assert.notEqual(call.method, "DELETE");
    if (call.method === "PATCH") {
      assert.equal("key" in (call.body as object), false);
      assert.equal("deleted" in (call.body as object), false);
    }
  }
  assert.deepEqual(calls.slice(2).map(call => call.body), [{ status: "archived" }, { status: "active" }]);
});

test("unowned or unlisted native targets are refused before mutation", async () => {
  const calls: HttpRequest[] = [];
  const unowned: NativeSecret = { id: "native-1", companyId: "company-1", name: "Other", key: "other", status: "active" };
  const adapter = new PaperclipSecretsAdapter(async call => {
    calls.push(call);
    return reply(200, [unowned]);
  }, "company-1");
  await adapter.list();
  await assert.rejects(() => adapter.archive("native-1"),
    (error: unknown) => error instanceof AdapterError && error.code === "ownership_mismatch");
  await assert.rejects(() => adapter.archive("unlisted"),
    (error: unknown) => error instanceof AdapterError && error.code === "ownership_mismatch");
  assert.equal(calls.length, 1);
});
