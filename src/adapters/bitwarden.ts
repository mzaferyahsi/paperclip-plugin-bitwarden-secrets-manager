import { AdapterError } from "./types.js";
import type { BsmSdk, BsmSecret, BsmSnapshot, SelectedBsmSecret } from "./types.js";
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
    list(organizationId: string): Promise<{ success: boolean; errorMessage?: string | null; data?: { data: readonly { id?: string; organizationId?: string }[] } | null }>;
  };
}

function normalizeSdkFailure(message?: string | null): AdapterError {
  const text = message ?? "";
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}token/i.test(text)) return new AdapterError("configuration_required");
  if (/\b403\b|forbidden|permission denied/i.test(text)) return new AdapterError("configuration_required");
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
      const result = await bounded(client.secrets().list(organizationId));
      if (!result.success) throw normalizeSdkFailure(result.errorMessage);
      if (!Array.isArray(result.data?.data)) throw new AdapterError("snapshot_incomplete");
      const rows = result.data.data;
      if (rows.some(row => !row.id || !row.organizationId)) throw new AdapterError("snapshot_incomplete");
      return rows.map(row => ({ id: row.id!, organizationId: row.organizationId! }));
    },
    async getSecrets(ids) {
      const result = await bounded(client.secrets().getByIds([...ids]));
      if (!result.success) throw normalizeSdkFailure(result.errorMessage);
      if (!Array.isArray(result.data?.data)) throw new AdapterError("snapshot_incomplete");
      const rows = result.data.data;
      if (rows.some(row => !row.id || !row.organizationId || row.projectId === undefined || row.key === undefined ||
        row.value === undefined || !row.revisionDate)) throw new AdapterError("snapshot_incomplete");
      return rows.map(row => ({
        id: row.id!, organizationId: row.organizationId!, projectId: row.projectId!, key: row.key!,
        value: row.value!, revisionDate: row.revisionDate instanceof Date ? row.revisionDate.toISOString() : row.revisionDate!,
        ...(row.archived === undefined ? {} : { archived: row.archived }),
      }));
    },
  };
  if (client.projects) {
    adapter.listProjects = async organizationId => {
      const result = await bounded(client.projects!().list(organizationId));
      if (!result.success) throw normalizeSdkFailure(result.errorMessage);
      if (!Array.isArray(result.data?.data)) throw new AdapterError("snapshot_incomplete");
      const rows = result.data.data;
      if (rows.some(row => !row.id || !row.organizationId)) throw new AdapterError("snapshot_incomplete");
      return rows.map(row => ({ id: row.id!, organizationId: row.organizationId! }));
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

/** Read all selected source values before exposing a snapshot to diff/apply code. */
export async function readBsmSnapshot(
  sdk: BsmSdk,
  organizationId: string,
  selectedProjectIds: ReadonlySet<string>,
  batchSize = 100,
): Promise<BsmSnapshot> {
  if (!organizationId || selectedProjectIds.size === 0 || !Number.isInteger(batchSize) || batchSize < 1) {
    throw new AdapterError("invalid_input");
  }

  try {
    if (sdk.listProjects) {
      const visibleProjects = await sdk.listProjects(organizationId);
      const ids = new Set(visibleProjects.filter(project => project.organizationId === organizationId).map(project => project.id));
      if ([...selectedProjectIds].some(id => !ids.has(id))) throw new AdapterError("snapshot_incomplete");
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
    const ids = listed.map(row => row.id);
    const records: SelectedBsmSecret[] = [];
    let complete = true;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batchIds = ids.slice(offset, offset + batchSize);
      const batch = await sdk.getSecrets(batchIds);
      const byId = new Map(batch.map(secret => [secret.id, secret]));
      if (byId.size !== batchIds.length || batchIds.some(id => !byId.has(id))) {
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
        if (!selectedProjectIds.has(secret.projectId)) continue;
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
