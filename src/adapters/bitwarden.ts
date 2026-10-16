import { AdapterError } from "./types.js";
import type { BsmCatalogue, BsmSdk, BsmSecret, BsmSnapshot, SelectedBsmSecret } from "./types.js";
import { isRealProject, NO_PROJECT_ID, selectionAdmits, type ProjectSelection } from "../config.js";
import type { LogLevel } from "@bitwarden/sdk-napi";

/** Small structural boundary around the official SDK; native SDK types stay outside callers. */
export interface BitwardenClientLike {
  secrets(): {
    list(organizationId: string): Promise<{ success: boolean; errorMessage?: string | null; data?: { data: readonly { id?: string; organizationId?: string; key?: string }[] } | null }>;
    getByIds(ids: string[]): Promise<{ success: boolean; errorMessage?: string | null; data?: { data: readonly {
      id?: string; organizationId?: string; projectId?: string | null; key?: string;
      value?: string; revisionDate?: string | Date; archived?: boolean;
    }[] } | null }>;
  };
  projects?(): {
    list(organizationId: string): Promise<{ success: boolean; errorMessage?: string | null; data?: { data: readonly { id?: string; organizationId?: string; name?: string }[] } | null }>;
  };
}

/**
 * The shipped SDK wrapper unwraps its response and throws on failure, so it returns `{data: rows}`.
 * Fixtures and older typings use `{success, data: {data: rows}}`. Accept both; thrown errors are normalized.
 */
async function sdkRows<R>(call: () => Promise<any>): Promise<readonly R[] | undefined> {
  let result: any;
  try { result = await call(); } catch (error) {
    throw error instanceof AdapterError ? error : normalizeSdkFailure(error instanceof Error ? error.message : "");
  }
  if (result && typeof result === "object" && "success" in result) {
    if (!result.success) throw normalizeSdkFailure(result.errorMessage);
    return Array.isArray(result.data?.data) ? result.data.data : undefined;
  }
  return Array.isArray(result?.data) ? result.data : undefined;
}

function normalizeSdkFailure(message?: string | null): AdapterError {
  const text = message ?? "";
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}token/i.test(text)) return new AdapterError("bsm_credential_rejected");
  if (/\b403\b|forbidden|permission denied/i.test(text)) return new AdapterError("bsm_permission_denied");
  if (/\b429\b|too many requests|rate limit/i.test(text)) return new AdapterError("remote_unavailable", true);
  return new AdapterError("remote_unavailable", true);
}

export function bitwardenSdkAdapter(client: BitwardenClientLike): BsmSdk {
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AdapterError("remote_unavailable", true)), 30_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const adapter: BsmSdk = {
    async listSecretIds(organizationId) {
      const rows = await bounded(sdkRows<any>(() => client.secrets().list(organizationId)));
      if (!rows) throw new AdapterError("snapshot_incomplete");
      if (rows.some(row => !row.id || !row.organizationId)) throw new AdapterError("snapshot_incomplete");
      return rows.map(row => ({ id: row.id!, organizationId: row.organizationId! }));
    },
    async getSecrets(ids) {
      const rows = await bounded(sdkRows<any>(() => client.secrets().getByIds([...ids])));
      if (!rows) throw new AdapterError("snapshot_incomplete");
      if (rows.some(row => !row.id || !row.organizationId || row.key === undefined ||
        row.value === undefined || !row.revisionDate)) throw new AdapterError("snapshot_incomplete");
      return rows.map(row => ({
        id: row.id!, organizationId: row.organizationId!, ...(row.projectId === undefined ? {} : { projectId: row.projectId }), key: row.key!,
        value: row.value!, revisionDate: row.revisionDate instanceof Date ? row.revisionDate.toISOString() : row.revisionDate!,
        ...(row.archived === undefined ? {} : { archived: row.archived }),
      }));
    },
  };
  if (client.projects) {
    adapter.listProjects = async organizationId => {
      const rows = await bounded(sdkRows<any>(() => client.projects!().list(organizationId)));
      if (!rows) throw new AdapterError("snapshot_incomplete");
      if (rows.some(row => !row.id || !row.organizationId)) throw new AdapterError("snapshot_incomplete");
      return rows.map(row => ({ id: row.id!, organizationId: row.organizationId!, ...(typeof row.name === "string" ? { name: row.name } : {}) }));
    };
  }
  return adapter;
}

/** Construct and authenticate the official Node-API client without a state file. */
export async function createAuthenticatedBitwardenSdk(token: string, region: "US" | "EU" = "US"): Promise<BsmSdk> {
  if (!token || !token.trim()) throw new AdapterError("configuration_required");
  const sdk = await import("@bitwarden/sdk-napi");
  const suffix = region === "EU" ? ".eu" : ".com";
  const client = new sdk.BitwardenClient({
    apiUrl: `https://api.bitwarden${suffix}`,
    identityUrl: `https://identity.bitwarden${suffix}`,
    deviceType: sdk.DeviceType.SDK,
    userAgent: "paperclip-plugin-bitwarden-secrets-manager-sync/0.1.2",
  }, 4 as LogLevel);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.auth().loginAccessToken(token),
        new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new AdapterError("remote_unavailable", true)), 30_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  } catch (error) {
    // Normalize known SDK status text in memory. Never expose or persist its message.
    throw error instanceof AdapterError ? error : normalizeSdkFailure(error instanceof Error ? error.message : "");
  }
  return bitwardenSdkAdapter(client as unknown as BitwardenClientLike);
}

/** Overall wall-clock budget for one discovery / snapshot pass. Running out reports "incomplete"; it never drops secrets silently. */
export const DISCOVERY_BUDGET_MS = 10 * 60_000;
const BATCH_ATTEMPTS = 3;

/**
 * Read one batch with a bounded retry. Credential/permission failures propagate at once. A batch that keeps
 * failing with a retryable error returns null so the caller can mark the pass incomplete (never truncate silently).
 */
async function readBatch(sdk: BsmSdk, ids: readonly string[]): Promise<readonly BsmSecret[] | null> {
  for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
    try { return await sdk.getSecrets(ids); } catch (error) {
      const failure = error instanceof AdapterError ? error : normalizeSdkFailure(error instanceof Error ? error.message : "");
      if (!failure.retryable) throw failure;
      if (attempt === BATCH_ATTEMPTS) return null;
    }
  }
  return null;
}

/**
 * Discovery (ALR-1698): SDK 1.0.0 `list` carries no project, so project membership is learned from `getByIds`,
 * which returns it together with the value. Every organisation secret value therefore passes through worker
 * memory here. That is the Boss-approved exception. The value is dropped as each batch ends and only
 * {id, key, projectId} survives. Nothing returned from this function can hold a value.
 */
export async function discoverCatalogue(sdk: BsmSdk, organizationId: string, batchSize = 100, budgetMs = DISCOVERY_BUDGET_MS, clock: () => number = Date.now): Promise<BsmCatalogue> {
  if (!organizationId || !Number.isInteger(batchSize) || batchSize < 1) throw new AdapterError("invalid_input");
  try {
    const visible = sdk.listProjects ? (await sdk.listProjects(organizationId)).filter(p => p.organizationId === organizationId) : [];
    const names = new Map(visible.map(p => [p.id.toLowerCase(), p.name ?? null]));
    const listed = await sdk.listSecretIds(organizationId);
    const seen = new Set<string>();
    for (const row of listed) {
      if (!row.id || seen.has(row.id) || row.organizationId !== organizationId) throw new AdapterError("snapshot_incomplete");
      seen.add(row.id);
    }
    const ids = listed.map(row => row.id);
    const secrets: BsmCatalogue["secrets"] = [];
    const unselectable: BsmCatalogue["unselectable"] = [];
    const started = clock();
    let complete = true;
    let readCount = 0;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      if (clock() - started > budgetMs) { complete = false; break; }
      const batchIds = ids.slice(offset, offset + batchSize);
      const batch = await readBatch(sdk, batchIds);
      if (!batch) { complete = false; break; }
      const byId = new Map(batch.map(secret => [secret.id, secret]));
      if (byId.size !== batchIds.length || batchIds.some(id => !byId.has(id)) || batch.some(secret => !batchIds.includes(secret.id))) {
        throw new AdapterError("snapshot_incomplete");
      }
      for (const id of batchIds) {
        const secret = byId.get(id)!;
        if (secret.organizationId !== organizationId) throw new AdapterError("snapshot_incomplete");
        readCount++;
        if (secret.archived) continue;
        // Copy only metadata; the row (and its value) goes out of scope with the batch.
        if (secret.projectId === undefined) unselectable.push({ id: secret.id, key: secret.key });
        else secrets.push({ id: secret.id, key: secret.key, projectId: secret.projectId ?? NO_PROJECT_ID, selectable: true });
      }
    }
    if (readCount < ids.length) complete = false;
    // A secret in a project the token cannot list still gets a group, named by id only; never guessed.
    const counts = new Map<string, number>();
    for (const secret of secrets) counts.set(secret.projectId.toLowerCase(), (counts.get(secret.projectId.toLowerCase()) ?? 0) + 1);
    const projects: BsmCatalogue["projects"] = [];
    for (const [id, name] of names) projects.push({ id, name, secretCount: counts.get(id) ?? 0 });
    for (const [id, secretCount] of counts) if (!names.has(id) && id !== NO_PROJECT_ID) projects.push({ id, name: null, secretCount });
    if (counts.has(NO_PROJECT_ID)) projects.push({ id: NO_PROJECT_ID, name: null, secretCount: counts.get(NO_PROJECT_ID)! });
    return { projects, secrets: secrets.map(s => ({ ...s, projectId: s.projectId.toLowerCase() })), unselectable, complete, listedCount: ids.length, readCount };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("remote_unavailable", true);
  }
}

/**
 * Read the selected source values before exposing a snapshot to diff/apply code (ALR-1698).
 * `selection` is a union of per-project entries (a plain Set means whole-project for each ID, legacy).
 * Membership comes from the list row when present; when the list carries none (SDK 1.0.0) every listed
 * secret is read in batches and kept only if its own project is admitted. Values of secrets that are not
 * admitted are dropped with the batch. A secret with no reported project is unselectable: it is skipped and
 * the snapshot is marked incomplete so it can never authorize a removal.
 */
export async function readBsmSnapshot(
  sdk: BsmSdk,
  organizationId: string,
  selection: ReadonlySet<string> | readonly ProjectSelection[],
  batchSize = 100,
  budgetMs = DISCOVERY_BUDGET_MS,
  clock: () => number = Date.now,
): Promise<BsmSnapshot> {
  const entries: readonly ProjectSelection[] = selection instanceof Set
    ? [...selection].map(projectId => ({ projectId, mode: "all" as const })) : selection as readonly ProjectSelection[];
  if (!organizationId || entries.length === 0 || !Number.isInteger(batchSize) || batchSize < 1) {
    throw new AdapterError("invalid_input");
  }
  const projectKeys = new Set(entries.map(entry => entry.projectId.toLowerCase()).filter(isRealProject));

  try {
    // Fail closed, typed, when a selected project is gone; never fall back to a wider scope.
    if (sdk.listProjects && projectKeys.size > 0) {
      const visibleProjects = await sdk.listProjects(organizationId);
      const ids = new Set(visibleProjects.filter(project => project.organizationId === organizationId).map(project => project.id.toLowerCase()));
      if ([...projectKeys].some(id => !ids.has(id))) throw new AdapterError("selected_project_missing");
    }
    const listed = await sdk.listSecretIds(organizationId);
    const seen = new Set<string>();
    for (const row of listed) {
      if (!row.id || seen.has(row.id) || row.organizationId !== organizationId) {
        throw new AdapterError("snapshot_incomplete");
      }
      seen.add(row.id);
    }

    const summaries = new Map(listed.map(row => [row.id, row]));
    // Rows whose project the list already reports are admitted or rejected before any value read.
    const candidates = listed.filter(row => row.projectId === undefined ||
      selectionAdmits(entries, row.projectId || NO_PROJECT_ID, row.id));
    const ids = candidates.map(row => row.id);
    const records: SelectedBsmSecret[] = [];
    let complete = true;
    let skipped = 0;
    const started = clock();
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      // Out of time, or a batch kept failing: what was read is still valid to write, but the snapshot is
      // partial so it can never authorize a removal. The next run retries.
      if (clock() - started > budgetMs) { complete = false; break; }
      const batchIds = ids.slice(offset, offset + batchSize);
      const batch = await readBatch(sdk, batchIds);
      if (!batch) { complete = false; break; }
      const byId = new Map(batch.map(secret => [secret.id, secret]));
      if (byId.size !== batchIds.length || batchIds.some(id => !byId.has(id)) || batch.some(secret => !batchIds.includes(secret.id))) {
        throw new AdapterError("snapshot_incomplete");
      }
      for (const id of batchIds) {
        const secret = byId.get(id)!;
        const summary = summaries.get(id)!;
        if (secret.organizationId !== organizationId || secret.organizationId !== summary.organizationId) {
          throw new AdapterError("snapshot_incomplete");
        }
        if (secret.projectId === undefined) {
          // Unreadable project: not selectable, never guessed. It also blocks removals for this run.
          complete = false;
          skipped++;
          continue;
        }
        const projectId = secret.projectId || NO_PROJECT_ID;
        // The secret's own project decides; a value outside the selection is dropped here.
        if (!selectionAdmits(entries, projectId, secret.id)) continue;
        if (secret.archived) { skipped++; continue; }
        // A listed but unusable value is not evidence of absence. Mark the
        // snapshot partial so callers cannot use it to authorize removals.
        if (!secret.value.trim()) {
          complete = false;
          skipped++;
          continue;
        }
        records.push({ ...secret, projectId });
      }
    }
    return { complete, secrets: records, skippedCount: skipped };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    // The native SDK exposes plain Error strings. Never return/log those messages.
    throw new AdapterError("remote_unavailable", true);
  }
}
