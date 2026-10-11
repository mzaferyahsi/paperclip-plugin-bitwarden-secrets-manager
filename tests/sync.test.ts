import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipSecretsAdapter } from "../src/adapters/paperclip.js";
import type { BsmSecret, HttpRequest, HttpResponse, NativeSecret } from "../src/adapters/types.js";
import { syncCompany, type SyncState } from "../src/sync.js";

const org = "550e8400-e29b-41d4-a716-446655440001";
const project = "550e8400-e29b-41d4-a716-446655440002";
const project2 = "550e8400-e29b-41d4-a716-446655440004";
const config = { bsmOrganizationId: org, bsmProjectIds: [project], targetSecretKeyPrefix: "bitwarden.", archiveOnRemoval: true };
const item: BsmSecret = { id: "550e8400-e29b-41d4-a716-446655440003", organizationId: org, projectId: project,
  key: "API_KEY", value: "fixture-value", revisionDate: "2026-10-10T12:00:00Z" };

function response(status: number, body: unknown): HttpResponse { return { status, json: async () => body }; }
function harness(initial: NativeSecret[] = [], options: { loseRotateResponse?: boolean } = {}) {
  const secrets = new Map(initial.map(secret => [secret.id, structuredClone(secret)]));
  const requests: HttpRequest[] = [];
  let rotateCount = 0;
  let nextId = 0;
  let state: SyncState | undefined;
  const transport = async (request: HttpRequest) => {
    requests.push(request);
    if (request.method === "GET") return response(200, [...secrets.values()]);
    const id = decodeURIComponent(request.path.split("/")[3] ?? "");
    if (request.method === "POST" && request.path.endsWith("/secrets")) {
      const input = request.body as Record<string, unknown>;
      const created: NativeSecret = { id: `native-${++nextId}`, companyId: "company-1", name: String(input.name), key: String(input.key),
        status: "active", latestVersion: 1, providerMetadata: input.providerMetadata as Record<string, unknown> };
      secrets.set(created.id, created);
      return response(200, created);
    }
    const existing = secrets.get(id);
    assert.ok(existing, `missing native ${id}`);
    if (request.path.endsWith("/rotate")) {
      rotateCount++;
      existing.latestVersion = (existing.latestVersion ?? 0) + 1;
      if (options.loseRotateResponse && rotateCount === 1) throw new Error("response lost");
      return response(200, { latestVersion: existing.latestVersion });
    }
    const patch = request.body as Record<string, unknown>;
    if (patch.providerMetadata) existing.providerMetadata = patch.providerMetadata as Record<string, unknown>;
    if (patch.name) existing.name = String(patch.name);
    if (patch.status) existing.status = patch.status as NativeSecret["status"];
    return response(200, existing);
  };
  const sdk = (source?: BsmSecret, complete = true) => ({
    listSecretIds: async () => source ? [{ id: source.id, organizationId: source.organizationId, projectId: source.projectId }] : [],
    getSecrets: async () => source ? [{ ...source }] : [],
  });
  const execute = (source?: BsmSecret, complete = true, previousState = state, projectIds = [project], prefix = "bitwarden.") => {
    // The snapshot reader gets `complete=false` for whitespace-only values itself.
    void complete;
    const localConfig = { ...config, bsmProjectIds: projectIds, targetSecretKeyPrefix: prefix };
    const adapter = new PaperclipSecretsAdapter(transport, "company-1");
    return syncCompany(localConfig, {
      sdk: sdk(source), native: adapter, previousState,
      stateFingerprint: previousState?.configFingerprint,
      generation: previousState?.generation,
      destinationVersions: previousState?.destinationVersions,
      absenceEvidence: previousState?.absenceEvidence,
      save: async next => { state = structuredClone(next); },
    });
  };
  return { execute, secrets, requests, get rotateCount() { return rotateCount; }, get state() { return state; } };
}

test("creates once, then preserves native ID and key through source rename and project move", async () => {
  const h = harness();
  await h.execute(item, true, undefined, [project, project2]);
  const created = [...h.secrets.values()][0]!;
  const id = created.id;
  const key = created.key;
  await h.execute({ ...item, key: "RENAMED", projectId: project2, revisionDate: "2026-10-11T00:00:00Z" }, true, h.state, [project, project2]);
  const after = h.secrets.get(id)!;
  assert.equal(after.id, id);
  assert.equal(after.key, key);
  assert.match(after.name, /^RENAMED /);
  assert.equal((after.providerMetadata as Record<string, unknown>).bsmProjectId, project2);
  assert.equal(h.requests.some(req => req.method === "DELETE"), false);
});

test("an incomplete source snapshot never archives an owned destination", async () => {
  const metadata = { source: "bitwarden_secrets_manager", syncOwner: "mzaferyahsi.bitwarden-secrets-manager-sync",
    bsmOrganizationId: org, bsmSecretId: item.id, bsmProjectId: project, sourceRevision: item.revisionDate, identityVersion: 1 };
  const target: NativeSecret = { id: "native-existing", companyId: "company-1", name: "API_KEY", key: `bitwarden.${org}.${item.id}`,
    status: "active", latestVersion: 1, providerMetadata: metadata };
  const h = harness([target]);
  const result = await h.execute({ ...item, value: " \t " });
  assert.equal(result.status, "partial");
  assert.equal(h.secrets.get(target.id)?.status, "active");
  assert.equal(h.requests.some(req => req.method === "PATCH" && (req.body as any)?.status === "archived"), false);
});

test("archives only after two complete absences and journals a lost rotation response", async () => {
  const metadata = { source: "bitwarden_secrets_manager", syncOwner: "mzaferyahsi.bitwarden-secrets-manager-sync",
    bsmOrganizationId: org, bsmSecretId: item.id, bsmProjectId: project, sourceRevision: item.revisionDate, identityVersion: 1 };
  const target: NativeSecret = { id: "native-existing", companyId: "company-1", name: "API_KEY", key: `bitwarden.${org}.${item.id}`,
    status: "active", latestVersion: 1, providerMetadata: metadata };
  const removal = harness([target]);
  await removal.execute(undefined);
  assert.equal(removal.secrets.get(target.id)?.status, "active");
  await removal.execute(undefined);
  assert.equal(removal.secrets.get(target.id)?.status, "archived");

  const lost = harness([target], { loseRotateResponse: true });
  const changed = { ...item, revisionDate: "2026-10-11T00:00:00Z" };
  const interrupted = await lost.execute(changed);
  assert.equal(interrupted.status, "partial");
  assert.equal(interrupted.itemJournal?.[0]?.phase, "planned");
  await lost.execute(changed);
  assert.equal(lost.rotateCount, 1);
  assert.equal((lost.secrets.get(target.id)?.providerMetadata as Record<string, unknown>).sourceRevision, changed.revisionDate);
});

test("a namespace change establishes a new removal baseline and never silently archives old inventory", async () => {
  const h = harness();
  await h.execute(item);
  const target = [...h.secrets.values()][0]!;
  await h.execute(undefined, true, h.state, [project], "renamed.");
  await h.execute(undefined, true, h.state, [project], "renamed.");
  assert.equal(h.secrets.get(target.id)?.status, "active");
  assert.equal(h.state?.warningCode, "removal_scope_changed");
});
