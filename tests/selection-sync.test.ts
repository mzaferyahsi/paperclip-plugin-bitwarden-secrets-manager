import test from "node:test";
import assert from "node:assert/strict";
import { PaperclipSecretsAdapter } from "../src/adapters/paperclip.js";
import type { BsmSecret, HttpRequest, HttpResponse, NativeSecret } from "../src/adapters/types.js";
import { AdapterError } from "../src/adapters/types.js";
import { syncCompany, type SyncState } from "../src/sync.js";
import type { ProjectSelection } from "../src/config.js";

const org = "550e8400-e29b-41d4-a716-446655440001";
const P1 = "550e8400-e29b-41d4-a716-446655440021", P2 = "550e8400-e29b-41d4-a716-446655440022";
const A = "550e8400-e29b-41d4-a716-446655440031", B = "550e8400-e29b-41d4-a716-446655440032", C = "550e8400-e29b-41d4-a716-446655440033";
const rev = "2026-10-10T12:00:00Z";
const mk = (id: string, projectId: string): BsmSecret => ({ id, organizationId: org, projectId, key: `K_${id.slice(-2)}`, value: `val-${id.slice(-2)}`, revisionDate: rev });

function harness() {
  const secrets = new Map<string, NativeSecret>();
  const requests: HttpRequest[] = [];
  let n = 0, state: SyncState | undefined;
  const reply = (status: number, body: unknown): HttpResponse => ({ status, json: async () => body });
  const transport = async (r: HttpRequest) => {
    requests.push(r);
    if (r.method === "GET") return reply(200, [...secrets.values()]);
    if (r.method === "POST" && r.path.endsWith("/secrets")) {
      const i = r.body as Record<string, unknown>;
      const c: NativeSecret = { id: `native-${++n}`, companyId: "company-1", name: String(i.name), key: String(i.key), status: "active", latestVersion: 1, providerMetadata: i.providerMetadata as Record<string, unknown> };
      secrets.set(c.id, c); return reply(200, c);
    }
    const e = secrets.get(decodeURIComponent(r.path.split("/")[3] ?? ""))!;
    const p = r.body as Record<string, unknown>;
    if (p?.providerMetadata) e.providerMetadata = p.providerMetadata as Record<string, unknown>;
    if (p?.name) e.name = String(p.name);
    if (p?.status) e.status = p.status as NativeSecret["status"];
    return reply(200, e);
  };
  const fetched: string[][] = [];
  const run = (source: BsmSecret[], selection: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const cfg = { bsmOrganizationId: org, targetSecretKeyPrefix: "bitwarden.", archiveOnRemoval: true, ...selection, ...extra };
    return syncCompany(cfg, {
      sdk: {
        listSecretIds: async () => source.map((s) => ({ id: s.id, organizationId: org, projectId: s.projectId })),
        getSecrets: async (ids) => { fetched.push([...ids]); return source.filter((s) => ids.includes(s.id)); },
      },
      native: new PaperclipSecretsAdapter(transport, "company-1"), previousState: state,
      stateFingerprint: state?.configFingerprint, generation: state?.generation,
      destinationVersions: state?.destinationVersions, absenceEvidence: state?.absenceEvidence,
      save: async (next) => { state = structuredClone(next); },
    });
  };
  const bySource = (id: string) => [...secrets.values()].find((s) => (s.providerMetadata as Record<string, unknown>).bsmSecretId === id);
  return { run, secrets, requests, fetched, bySource, get state() { return state; } };
}
const sel = (...e: ProjectSelection[]) => ({ bsmProjectSelections: e });
const mutations = (h: ReturnType<typeof harness>) => h.requests.filter((r) => r.method !== "GET");

test("selected mode syncs only chosen IDs; whole-project picks up newly added secrets", async () => {
  const h = harness();
  const source = [mk(A, P1), mk(B, P1), mk(C, P2)];
  await h.run(source, sel({ projectId: P1, mode: "selected", secretIds: [A] }));
  assert.ok(h.bySource(A)); assert.equal(h.bySource(B), undefined); assert.equal(h.bySource(C), undefined);
  assert.deepEqual(h.fetched.flat(), [A], "excluded values were never fetched");
  const added = mk("550e8400-e29b-41d4-a716-446655440034", P1);
  await h.run([...source, added], sel({ projectId: P1, mode: "selected", secretIds: [A] }));
  assert.equal(h.bySource(added.id), undefined, "selected mode does not auto-include new secrets");
  await h.run([...source, added], sel({ projectId: P1, mode: "all" }));
  assert.ok(h.bySource(added.id) && h.bySource(B), "whole project includes new and existing secrets");
});

test("scope withdrawal never archives, deletes or reactivates native secrets, even with archiveOnRemoval", async () => {
  const h = harness();
  const source = [mk(A, P1), mk(B, P1)];
  await h.run(source, sel({ projectId: P1, mode: "all" }));
  const nativeB = h.bySource(B)!;
  // Narrow whole-project to selected-A, then keep running; B is still in BSM but withdrawn from scope.
  for (let i = 0; i < 4; i++) await h.run(source, sel({ projectId: P1, mode: "selected", secretIds: [A] }));
  assert.equal(h.secrets.get(nativeB.id)?.status, "active");
  assert.equal(h.requests.some((r) => r.method === "DELETE"), false);
  assert.equal(h.requests.some((r) => (r.body as { status?: string } | undefined)?.status === "archived"), false);
  assert.equal(h.state?.warningCode, "removal_scope_changed", "scope change is surfaced and pauses removal evidence");
  // Dropping a whole project is the same: its native secrets are left alone.
  for (let i = 0; i < 4; i++) await h.run(source, sel({ projectId: P2, mode: "all" }));
  assert.equal(h.bySource(A)?.status, "active");
  assert.equal(mutations(h).filter((r) => r.method === "PATCH" && (r.body as { status?: string }).status).length, 0);
  // A natively archived secret that comes back into scope is not reactivated.
  h.secrets.get(nativeB.id)!.status = "archived";
  await h.run(source, sel({ projectId: P1, mode: "all" }));
  assert.equal(h.secrets.get(nativeB.id)?.status, "archived");
  assert.equal(h.state?.warningCode, "archived_source_reappeared");
});

test("removal safety is preserved: two complete absences inside the scope archive; off by default", async () => {
  const h = harness();
  const scope = sel({ projectId: P1, mode: "selected", secretIds: [A, B] });
  await h.run([mk(A, P1), mk(B, P1)], scope);
  await h.run([mk(A, P1)], scope, { archiveOnRemoval: false });
  await h.run([mk(A, P1)], scope, { archiveOnRemoval: false });
  assert.equal(h.bySource(B)?.status, "active", "archiveOnRemoval false never archives");
  await h.run([mk(A, P1)], scope);
  assert.equal(h.bySource(B)?.status, "active", "first absence only");
  await h.run([mk(A, P1)], scope);
  assert.equal(h.bySource(B)?.status, "archived");
  assert.equal(h.bySource(A)?.status, "active");
});

test("an incomplete snapshot (unusable value) never authorizes removal under a selection", async () => {
  const h = harness();
  const scope = sel({ projectId: P1, mode: "selected", secretIds: [A, B] });
  await h.run([mk(A, P1), mk(B, P1)], scope);
  for (let i = 0; i < 3; i++) {
    const r = await h.run([{ ...mk(A, P1), value: " " }], scope);
    assert.equal(r.status, "partial");
  }
  assert.equal(h.bySource(B)?.status, "active");
});

test("moving a selected secret to an unselected project removes it from scope without touching it immediately", async () => {
  const h = harness();
  const scope = sel({ projectId: P1, mode: "selected", secretIds: [A] });
  await h.run([mk(A, P1)], scope);
  const r = await h.run([mk(A, P2)], scope);
  assert.equal(r.status, "success");
  assert.equal(h.bySource(A)?.status, "active", "one absence is not enough to archive");
});

test("legacy bsmProjectIds and the equivalent whole-project entries share a fingerprint, so upgrade is a no-op", async () => {
  const h = harness();
  const source = [mk(A, P1), mk(B, P2)];
  const first = await h.run(source, { bsmProjectIds: [P1, P2] });
  const second = await h.run(source, sel({ projectId: P2, mode: "all" }, { projectId: P1, mode: "all" }));
  assert.equal(second.configFingerprint, first.configFingerprint);
  assert.equal(second.warningCode, undefined);
  assert.equal(mutations(h).length, 2, "only the two creates from the first run");
});

test("invalid or conflicting selections stop before any read or write; there is no whole-org fallback", async () => {
  for (const scope of [{}, { bsmProjectIds: [] }, sel(), { bsmProjectIds: [P1], ...sel({ projectId: P1, mode: "all" }) }, sel({ projectId: P1, mode: "selected", secretIds: [] })]) {
    const h = harness();
    await assert.rejects(() => h.run([mk(A, P1)], scope), (e: unknown) => e instanceof AdapterError && e.code === "invalid_input");
    assert.equal(h.requests.length, 0);
    assert.equal(h.fetched.length, 0);
  }
});
