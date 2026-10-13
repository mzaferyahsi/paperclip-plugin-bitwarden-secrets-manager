import { AdapterError, type BsmSnapshot, type BsmSdk, type NativeSecret, type SecretOwnership } from "./adapters/types.js";
import { readBsmSnapshot } from "./adapters/bitwarden.js";
import { ownershipMatches, PaperclipSecretsAdapter, sourceIdentityKey } from "./adapters/paperclip.js";
import type { BsmConfig } from "./config.js";

const OWNER = "mzaferyahsi.bitwarden-secrets-manager-sync" as const;
const MAX_SECRETS = 500;
export type JournalItem = {
  sourceId: string; action: "create" | "rotate" | "metadata" | "archive";
  sourceRevision: string; destinationId?: string; priorVersion?: number;
  responseVersion?: number; phase: "planned" | "applied";
};
export type SyncState = {
  generation: number; status: string; errorCode?: string; warningCode?: string;
  lastAttemptAt?: string; lastSuccessAt?: string; configFingerprint?: string; removalFingerprint?: string;
  scheduledAnchor?: string; nextEligibleAt?: string; runtimeRefIds?: string[];
  processedCompanies?: number; itemJournal?: JournalItem[];
  destinationVersions?: Record<string, number>; absenceEvidence?: Record<string, { fingerprint: string; count: number }>;
  lastDurationMs?: number; counts?: SyncCounts; projectNames?: Record<string, string>;
};
export type SyncCounts = { read: number; created: number; updated: number; unchanged: number; archived: number; failed: number };
export type SyncPorts = {
  sdk: BsmSdk;
  native: PaperclipSecretsAdapter;
  save(state: SyncState): Promise<void>;
  previousState?: SyncState;
  stateFingerprint?: string;
  generation?: number;
  destinationVersions?: Record<string, number>;
  absenceEvidence?: Record<string, { fingerprint: string; count: number }>;
  deadlineAt?: number;
  now?: () => number;
};

function configFingerprint(config: BsmConfig): string {
  return JSON.stringify({
    organization: config.bsmOrganizationId,
    projects: [...(config.bsmProjectIds as string[])].sort(),
    prefix: config.targetSecretKeyPrefix ?? "bitwarden.",
    sourceRef: (config.bsmAccessToken as { secretId?: string } | undefined)?.secretId ?? null,
  });
}

function displayName(key: string, id: string): string {
  const cleaned = key.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 72) || "Secret";
  return `${cleaned} (${id})`;
}

function ownership(config: BsmConfig, source: BsmSnapshot["secrets"][number]): SecretOwnership {
  return {
    source: "bitwarden_secrets_manager", syncOwner: OWNER,
    bsmOrganizationId: String(config.bsmOrganizationId), bsmSecretId: source.id,
    bsmProjectId: source.projectId, sourceRevision: source.revisionDate, identityVersion: 1,
  };
}

function destinationKey(config: BsmConfig, orgId: string, sourceId: string): string {
  const prefix = String(config.targetSecretKeyPrefix ?? "bitwarden.");
  const key = `${prefix}${orgId}.${sourceId}`;
  if (key.length > 120 || !/^[A-Za-z0-9._-]+$/.test(key)) throw new AdapterError("invalid_input");
  return key;
}

function safeErrorCode(error: unknown): string {
  return error instanceof AdapterError ? error.code : "remote_unavailable";
}

/**
 * Reconcile one company from complete snapshots. The state journal contains only IDs,
 * revisions and native version numbers. Values are always re-fetched from BSM.
 */
export async function syncCompany(config: BsmConfig, ports: SyncPorts): Promise<SyncState> {
  const now = ports.now ?? Date.now;
  const previous = (await ports.native.list()).slice();
  const inventoryIds = new Set<string>();
  const inventoryKeys = new Set<string>();
  for (const row of previous) {
    if (inventoryIds.has(row.id) || inventoryKeys.has(row.key)) throw new AdapterError("snapshot_incomplete");
    inventoryIds.add(row.id);
    inventoryKeys.add(row.key);
  }
  const fingerprint = configFingerprint(config);
  const configChanged = ports.stateFingerprint !== undefined && ports.stateFingerprint !== fingerprint;
  if (configChanged) ports.absenceEvidence = {};
  const removalFingerprint = ports.previousState?.removalFingerprint ?? ports.stateFingerprint ?? fingerprint;
  const fingerprintUnchanged = ports.stateFingerprint === fingerprint && removalFingerprint === fingerprint;
  const snapshot = await readBsmSnapshot(ports.sdk, String(config.bsmOrganizationId), new Set(config.bsmProjectIds as string[]), 100);
  if (snapshot.secrets.length > MAX_SECRETS) throw new AdapterError("snapshot_incomplete");

  const orgId = String(config.bsmOrganizationId);
  const owned = previous.filter(secret => {
    const meta = secret.providerMetadata as Partial<SecretOwnership> | undefined;
    return meta?.source === "bitwarden_secrets_manager" && meta.syncOwner === OWNER && meta.identityVersion === 1 && meta.bsmOrganizationId === orgId;
  });
  const bySource = new Map<string, NativeSecret>();
  const byKey = new Map(previous.map(secret => [secret.key, secret]));
  for (const target of owned) {
    const meta = target.providerMetadata as Partial<SecretOwnership>;
    const id = meta.bsmSecretId;
    if (!id || bySource.has(id)) throw new AdapterError("snapshot_incomplete");
    bySource.set(id, target);
  }
  const desired = new Map(snapshot.secrets.map(secret => [secret.id, secret]));
  if (desired.size !== snapshot.secrets.length) throw new AdapterError("snapshot_incomplete");
  const pendingJournal = new Map((ports.previousState?.itemJournal ?? [])
    .filter(item => item.phase === "planned").map(item => [item.sourceId, item]));
  const keyOwners = new Map<string, string>();
  const candidates: Array<{ source: (typeof snapshot.secrets)[number]; target?: NativeSecret; action: "create" | "rotate" | "metadata" | "none" }> = [];
  for (const source of snapshot.secrets) {
    const key = destinationKey(config, orgId, source.id);
    const name = displayName(source.key, source.id);
    const existing = bySource.get(source.id);
    const keyCollision = byKey.get(key);
    if (keyCollision && (!existing || keyCollision.id !== existing.id) && !ownershipMatches(keyCollision, orgId, source.id)) throw new AdapterError("ownership_mismatch");
    const nameCollision = previous.find(secret => secret.name === name && (!existing || secret.id !== existing.id));
    if (nameCollision) throw new AdapterError("ownership_mismatch");
    const priorKeyOwner = keyOwners.get(key);
    if (priorKeyOwner && priorKeyOwner !== source.id) throw new AdapterError("snapshot_incomplete");
    keyOwners.set(key, source.id);
    if (!existing) { candidates.push({ source, action: "create" }); continue; }
    if (existing.status !== "active") { candidates.push({ source, target: existing, action: "none" }); continue; }
    const metadata = existing.providerMetadata as Partial<SecretOwnership> | undefined;
    let action: "rotate" | "metadata" | "none" = metadata?.sourceRevision !== source.revisionDate ||
      (existing.latestVersion !== undefined && ports.destinationVersions?.[source.id] !== undefined && existing.latestVersion !== ports.destinationVersions[source.id])
      ? "rotate" : metadata?.bsmProjectId !== source.projectId || existing.name !== displayName(source.key, source.id) ? "metadata" : "none";
    const pending = pendingJournal.get(source.id);
    const priorVersion = pending?.responseVersion ?? pending?.priorVersion;
    if (pending?.action === "rotate" && existing.latestVersion !== undefined && priorVersion !== undefined && existing.latestVersion > priorVersion) {
      // A prior rotate may have committed before its response was lost. The newer
      // native version proves the value write landed; finish metadata without replay.
      action = "metadata";
    }
    candidates.push({ source, target: existing, action });
  }

  const startedAt = now();
  const counts: SyncCounts = { read: snapshot.secrets.length, created: 0, updated: 0, unchanged: candidates.filter(c => c.action === "none").length, archived: 0, failed: snapshot.skippedCount };
  const generation = (ports.generation ?? 0) + 1;
  const state: SyncState = { ...(ports.previousState ?? {}), generation, status: "applying", errorCode: undefined,
    configFingerprint: fingerprint, removalFingerprint, itemJournal: [],
    ...(configChanged ? { absenceEvidence: {}, warningCode: "removal_scope_changed" } : {}),
    lastAttemptAt: new Date(now()).toISOString() };
  await ports.save(state);
  const versions = { ...(ports.destinationVersions ?? {}) };
  let hadFailure = false;
  let mutations = 0;
  let budgetExpired = ports.deadlineAt !== undefined && now() >= ports.deadlineAt;
  for (const candidate of candidates) {
    if (ports.deadlineAt !== undefined && now() >= ports.deadlineAt) { budgetExpired = true; break; }
    const { source, target, action } = candidate;
    if (action === "none") continue;
    const item: JournalItem = { sourceId: source.id, action, sourceRevision: source.revisionDate,
      ...(target ? { destinationId: target.id } : {}), ...(target?.latestVersion ? { priorVersion: target.latestVersion } : {}), phase: "planned" };
    state.itemJournal = [...(state.itemJournal ?? []), item];
    await ports.save(state);
    try {
      const providerMetadata = ownership(config, source);
      if (action === "create") {
        const created = await ports.native.create({
          name: displayName(source.key, source.id), key: destinationKey(config, orgId, source.id),
          provider: "local_encrypted", managedMode: "paperclip_managed", value: source.value, providerMetadata,
        });
        item.destinationId = created.id;
        if (created.latestVersion !== undefined) { item.responseVersion = created.latestVersion; versions[source.id] = created.latestVersion; }
      } else if (action === "rotate" && target) {
        await ports.native.rotate(target.id, source.value);
        // The response is not trusted to be idempotent. Re-list to recover the version
        // before metadata is updated; a restart can reconcile from this same marker.
        const after = await ports.native.list();
        const latest = after.find(row => row.id === target.id);
        if (latest?.latestVersion !== undefined) { item.responseVersion = latest.latestVersion; versions[source.id] = latest.latestVersion; }
        await ports.native.updateMetadata(target.id, displayName(source.key, source.id), providerMetadata);
      } else if (action === "metadata" && target) {
        await ports.native.updateMetadata(target.id, displayName(source.key, source.id), providerMetadata);
      }
      item.phase = "applied";
      if (action === "create") counts.created++; else counts.updated++;
      mutations++;
      await ports.save(state);
    } catch (error) {
      hadFailure = true;
      counts.failed++;
      state.status = "partial";
      state.errorCode = safeErrorCode(error);
      await ports.save(state);
      break;
    }
  }

  // Removal is gated by two complete absences under an unchanged scope fingerprint.
  // Any source/apply error suppresses this pass and does not advance success time.
  if (!budgetExpired && snapshot.complete && !hadFailure && config.archiveOnRemoval === true) {
    const evidence = { ...(configChanged ? {} : ports.absenceEvidence ?? {}) };
    const selectedProjects = new Set(config.bsmProjectIds as string[]);
    for (const target of owned) {
      const meta = target.providerMetadata as Partial<SecretOwnership>;
      const id = meta.bsmSecretId!;
      // Shrinking the allowlist is a config migration, never removal evidence.
      if (!selectedProjects.has(String(meta.bsmProjectId))) continue;
      if (desired.has(id) || target.status !== "active") { delete evidence[id]; continue; }
      const prior = evidence[id];
      const count = prior?.fingerprint === fingerprint ? prior.count + 1 : 1;
      evidence[id] = { fingerprint, count };
      if (count >= 2 && fingerprintUnchanged) {
        if (ports.deadlineAt !== undefined && now() >= ports.deadlineAt) { budgetExpired = true; break; }
        const item: JournalItem = { sourceId: id, action: "archive", sourceRevision: String(meta.sourceRevision ?? ""), destinationId: target.id, priorVersion: target.latestVersion, phase: "planned" };
        state.itemJournal = [...(state.itemJournal ?? []), item];
        await ports.save(state);
        try {
          await ports.native.archive(target.id);
          item.phase = "applied";
          delete evidence[id];
          counts.archived++;
          mutations++;
          await ports.save(state);
        } catch (error) {
          hadFailure = true;
          counts.failed++;
          state.errorCode = safeErrorCode(error);
          await ports.save(state);
          break;
        }
      }
    }
    ports.absenceEvidence = evidence;
  }

  state.destinationVersions = versions;
  state.counts = counts;
  state.lastDurationMs = Math.max(0, now() - startedAt);
  if (!configChanged || ports.absenceEvidence) state.absenceEvidence = ports.absenceEvidence;
  state.status = hadFailure || budgetExpired ? "partial" : snapshot.complete ? "success" : "partial";
  if (budgetExpired && !state.errorCode) state.errorCode = "time_budget_exhausted";
  if (!snapshot.complete && !state.errorCode) state.errorCode = "snapshot_incomplete";
  if (!hadFailure && snapshot.complete) state.lastSuccessAt = new Date(now()).toISOString();
  state.itemJournal = (state.itemJournal ?? []).filter(item => item.phase !== "applied");
  await ports.save(state);
  void mutations;
  return state;
}

// Keep source identity helper in this module's public contract for callers/tests.
export { sourceIdentityKey };
