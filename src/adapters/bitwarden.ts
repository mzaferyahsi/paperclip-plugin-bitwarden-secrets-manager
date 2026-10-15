import { AdapterError } from "./types.js";
import type { BsmSdk, BsmSecret, BsmSnapshot, SelectedBsmSecret } from "./types.js";
import { selectionAdmits, type ProjectSelection } from "../config.js";
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
      if (rows.some(row => !row.id || !row.organizationId || row.projectId === undefined || row.key === undefined ||
        row.value === undefined || !row.revisionDate)) throw new AdapterError("snapshot_incomplete");
      return rows.map(row => ({
        id: row.id!, organizationId: row.organizationId!, projectId: row.projectId!, key: row.key!,
        value: row.value!, revisionDate: row.revisionDate instanceof Date ? row.revisionDate.toISOString() : row.revisionDate!,
        ...(row.archived === undefined ? {} : { archived: row.archived }),
      }));
    },
  };
  adapter.describeSecrets = async ids => {
    const rows = await bounded(sdkRows<any>(() => client.secrets().getByIds([...ids])));
    if (!rows) throw new AdapterError("snapshot_incomplete");
    if (rows.some(row => !row.id || !row.organizationId || row.projectId === undefined || row.key === undefined)) throw new AdapterError("snapshot_incomplete");
    // Project membership is only returned with the value. Copy metadata fields only.
    return rows.map(row => ({
      id: row.id!, organizationId: row.organizationId!, projectId: row.projectId ?? null, key: row.key!,
      ...(row.archived === undefined ? {} : { archived: row.archived }),
    }));
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
    userAgent: "paperclip-plugin-bitwarden-secrets-manager-sync/0.1.0",
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

/**
 * Read the in-scope source values before exposing a snapshot to diff/apply code.
 * `selection` is a per-project union; a plain Set means whole-project for each ID (legacy).
 * Values are fetched only for IDs that can still be in scope: with no whole-project entry
 * and no project hint from the list, only explicitly selected IDs are requested. The SDK list
 * call returns no project, so whole-project entries must fetch to learn each secret's project.
 */
export async function readBsmSnapshot(
  sdk: BsmSdk,
  organizationId: string,
  selection: ReadonlySet<string> | readonly ProjectSelection[],
  batchSize = 100,
): Promise<BsmSnapshot> {
  const entries: readonly ProjectSelection[] = selection instanceof Set
    ? [...selection].map(projectId => ({ projectId, mode: "all" as const })) : selection as readonly ProjectSelection[];
  if (!organizationId || entries.length === 0 || !Number.isInteger(batchSize) || batchSize < 1) {
    throw new AdapterError("invalid_input");
  }
  const projectKeys = new Set(entries.map(entry => entry.projectId.toLowerCase()));
  const hasWholeProject = entries.some(entry => entry.mode === "all");
  const selectedIds = new Set(entries.flatMap(entry => entry.mode === "selected" ? entry.secretIds.map(id => id.toLowerCase()) : []));

  try {
    if (sdk.listProjects) {
      const visibleProjects = await sdk.listProjects(organizationId);
      const ids = new Set(visibleProjects.filter(project => project.organizationId === organizationId).map(project => project.id.toLowerCase()));
      if ([...projectKeys].some(id => !ids.has(id))) throw new AdapterError("snapshot_incomplete");
    }
    const listed = await sdk.listSecretIds(organizationId);
    const seen = new Set<string>();
    for (const row of listed) {
      if (!row.id || seen.has(row.id) || row.organizationId !== organizationId) {
        throw new AdapterError("snapshot_incomplete");
      }
      seen.add(row.id);
    }

    if (listed.length > 500) throw new AdapterError("snapshot_incomplete");
    // Filter before fetching values wherever the list metadata permits it.
    const candidates = listed.filter(row => {
      if (row.projectId !== undefined) return selectionAdmits(entries, row.projectId, row.id);
      return hasWholeProject || selectedIds.has(row.id.toLowerCase());
    });
    const ids = candidates.map(row => row.id);
    const records: SelectedBsmSecret[] = [];
    let complete = true;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batchIds = ids.slice(offset, offset + batchSize);
      const batch = await sdk.getSecrets(batchIds);
      const byId = new Map(batch.map(secret => [secret.id, secret]));
      if (byId.size !== batchIds.length || batchIds.some(id => !byId.has(id)) || batch.some(secret => !batchIds.includes(secret.id))) {
        throw new AdapterError("snapshot_incomplete");
      }
      for (const id of batchIds) {
        const secret = byId.get(id)!;
        const summary = listed.find(row => row.id === id)!;
        if (secret.organizationId !== organizationId || secret.organizationId !== summary.organizationId) {
          throw new AdapterError("snapshot_incomplete");
        }
        if (secret.archived) continue;
        if (secret.projectId === null) continue;
        if (!secret.projectId) throw new AdapterError("snapshot_incomplete");
        // The secret's actual project decides; a selected ID that moved elsewhere is out of scope.
        if (!selectionAdmits(entries, secret.projectId, secret.id)) continue;
        // A listed but unusable value is not evidence of absence. Mark the
        // snapshot partial so callers cannot use it to authorize removals.
        if (!secret.value.trim()) {
          complete = false;
          continue;
        }
        records.push({ ...secret, projectId: secret.projectId });
      }
    }
    return { complete, secrets: records, skippedCount: ids.length - records.length };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    // The native SDK exposes plain Error strings. Never return/log those messages.
    throw new AdapterError("remote_unavailable", true);
  }
}
