import { AdapterError } from "./types.js";
import type { BsmSdk, BsmSecret, BsmSnapshot } from "./types.js";

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
    const listed = await sdk.listSecretIds(organizationId);
    const seen = new Set<string>();
    for (const row of listed) {
      if (!row.id || seen.has(row.id) || row.organizationId !== organizationId) {
        throw new AdapterError("snapshot_incomplete");
      }
      seen.add(row.id);
    }

    const ids = listed.filter(row => selectedProjectIds.has(row.projectId)).map(row => row.id);
    const records: BsmSecret[] = [];
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
        if (secret.organizationId !== organizationId || secret.organizationId !== summary.organizationId || secret.projectId !== summary.projectId) {
          throw new AdapterError("snapshot_incomplete");
        }
        if (secret.archived || !secret.value.trim()) continue;
        records.push(secret);
      }
    }
    return { complete: true, secrets: records, skippedCount: ids.length - records.length };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    // The native SDK exposes plain Error strings. Never return/log those messages.
    throw new AdapterError("remote_unavailable", true);
  }
}
