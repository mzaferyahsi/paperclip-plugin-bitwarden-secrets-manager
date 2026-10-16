import test from "node:test";
import assert from "node:assert/strict";
import { ALL_SECRETS_ID, NO_PROJECT_ID } from "../src/config.ts";
import { readBsmSnapshot, discoverCatalogue } from "../.test-build/bitwarden-adapter.mjs";
import * as ui from "../.test-build/ui.mjs";

const org = "550e8400-e29b-41d4-a716-446655440013";
const projectId = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const secretId = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECTS = 40, TOTAL = 1250;
// 1,250 secrets over 40 projects (+ every 50th has no project). Values are marked so a leak is detectable.
const projOf = (n) => (n % 50 === 0 ? null : projectId(n % PROJECTS));
const keyOf = (n) => `KEY_${n % 3 === 0 ? "db" : "api"}_${n}`;
function stubSdk({ failBatch = -1, failTimes = 0 } = {}) {
  const calls = { batches: 0, sizes: [] };
  let failures = 0;
  return { calls, sdk: {
    listProjects: async () => Array.from({ length: PROJECTS }, (_, i) => ({ id: projectId(i), organizationId: org, name: `Project ${String(i).padStart(2, "0")}` })),
    listSecretIds: async () => Array.from({ length: TOTAL }, (_, n) => ({ id: secretId(n), organizationId: org })),
    getSecrets: async (ids) => {
      calls.batches++; calls.sizes.push(ids.length);
      if (failBatch >= 0 && ids[0] === secretId(failBatch * 100) && failures++ < failTimes) throw new Error("boom");
      return ids.map((sid) => { const n = Number(sid.slice(-12)); return { id: sid, organizationId: org, projectId: projOf(n), key: keyOf(n), value: `VALUE-${n}-SECRET`, revisionDate: "r" }; });
    } } };
}

test("discovery reads all 1,250 secrets in batches with no cap; counts are true; no value survives", async () => {
  const { sdk, calls } = stubSdk();
  const c = await discoverCatalogue(sdk, org);
  assert.equal(c.complete, true);
  assert.deepEqual([c.listedCount, c.readCount, c.secrets.length], [TOTAL, TOTAL, TOTAL]);
  assert.equal(calls.batches, 13); assert.ok(calls.sizes.every((n) => n <= 100));
  assert.equal(c.projects.reduce((n, p) => n + p.secretCount, 0), TOTAL);
  assert.equal(c.projects.find((p) => p.id === NO_PROJECT_ID).secretCount, 25);
  assert.ok(!JSON.stringify(c).includes("SECRET"), "no value in the catalogue");
});

test("a batch that keeps failing makes discovery incomplete, never silently truncated; one transient failure is retried", async () => {
  const flaky = stubSdk({ failBatch: 4, failTimes: 1 });
  assert.equal((await discoverCatalogue(flaky.sdk, org)).complete, true, "retried once");
  const broken = stubSdk({ failBatch: 4, failTimes: 99 });
  const c = await discoverCatalogue(broken.sdk, org);
  assert.deepEqual([c.complete, c.listedCount, c.readCount < TOTAL], [false, TOTAL, true]);
  assert.equal(c.readCount, 400, "batches before the failing one were read; nothing after is claimed");
});

test("the time budget reports incomplete rather than dropping secrets", async () => {
  const { sdk } = stubSdk();
  let t = 0;
  const c = await discoverCatalogue(sdk, org, 100, 1000, () => (t += 400));
  assert.equal(c.complete, false); assert.equal(c.listedCount, TOTAL); assert.ok(c.readCount < TOTAL && c.readCount > 0);
});

test("sync snapshot reads every secret for All secrets; an incomplete pass cannot authorise removals", async () => {
  const { sdk } = stubSdk();
  const all = await readBsmSnapshot(sdk, org, [{ projectId: ALL_SECRETS_ID, mode: "all" }]);
  assert.deepEqual([all.complete, all.secrets.length], [true, TOTAL]);
  const broken = stubSdk({ failBatch: 3, failTimes: 99 });
  const partial = await readBsmSnapshot(broken.sdk, org, [{ projectId: ALL_SECRETS_ID, mode: "all" }]);
  assert.equal(partial.complete, false); assert.equal(partial.secrets.length, 300);
  let t = 0;
  const slow = await readBsmSnapshot(stubSdk().sdk, org, [{ projectId: ALL_SECRETS_ID, mode: "all" }], 100, 1000, () => (t += 400));
  assert.equal(slow.complete, false);
});

test("selection spans pages: search + select all applies to every match, not the visible page", async () => {
  const c = await discoverCatalogue(stubSdk().sdk, org);
  const total = c.secrets.length;
  const db = ui.matchingSecrets(c, "KEY_db");
  assert.ok(db.length > ui.PAGE_SIZE * 3, "more matches than fit on several pages");
  assert.equal(db.length, c.secrets.filter((s) => s.key.startsWith("KEY_db")).length);
  let entries = ui.setMatching([], db, true);
  assert.equal(ui.selectionSummary(entries, c).secrets, db.length);
  assert.ok(ui.selectionValid(entries));
  // project-name search matches that project's secrets only
  const proj = ui.matchingSecrets(c, "Project 07");
  assert.ok(proj.length > 0 && proj.every((s) => s.projectId === projectId(7)));
  entries = ui.setMatching(entries, proj, true);
  assert.equal(ui.selectionSummary(entries, c).secrets, new Set([...db, ...proj].map((s) => s.id)).size);
  // clearing only the matches leaves the rest
  entries = ui.setMatching(entries, db, false);
  assert.equal(ui.selectionSummary(entries, c).secrets, proj.filter((s) => !s.key.startsWith("KEY_db")).length);
  // everything, then a whole project absorbs its individual ids
  entries = ui.setMatching([], c.secrets, true);
  assert.equal(ui.selectionSummary(entries, c).secrets, total);
  entries = ui.toggleProject(entries, projectId(7));
  assert.equal(ui.selectionSummary(entries, c).secrets, total, "whole project does not change the count");
  assert.deepEqual(ui.setMatching([{ projectId: ALL_SECRETS_ID, mode: "all" }], db, false), [{ projectId: ALL_SECRETS_ID, mode: "all" }]);
});

test("UI renders one page per group with true totals, a search box and the 'other pages' wording; no value", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const c = await discoverCatalogue(stubSdk().sdk, org);
  const html = renderToStaticMarkup(React.createElement(ui.SecretTree, { catalogue: c, entries: [], onChange() {} }));
  assert.match(html, new RegExp(`${TOTAL} secrets in 41 groups`));
  assert.match(html, /Search by key name or project/);
  assert.match(html, /including those on other pages/);
  assert.match(html, /Showing 1–20 of 41 · page 1 of 3/, "projects are paged");
  assert.ok((html.match(/<li/g) ?? []).length <= ui.GROUPS_PER_PAGE * ui.PAGE_SIZE);
  assert.match(html, /Showing 1–25 of 31 · page 1 of 2/, "secrets inside a group are paged and counted truly");
  assert.ok(!html.includes("SECRET"));
  const partial = renderToStaticMarkup(React.createElement(ui.SecretTree, { catalogue: { ...c, complete: false, readCount: 300, listedCount: TOTAL }, entries: [], onChange() {} }));
  assert.match(partial, /Discovery incomplete/); assert.match(partial, /300 of 1250/);
});
