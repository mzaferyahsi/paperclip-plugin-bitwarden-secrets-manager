export const PLUGIN_ID = "mzaferyahsi.bitwarden-secrets-manager-sync";
export type SecretRef = { type: "secret_ref"; secretId: string; version?: number | "latest" };
export type BsmConfig = Record<string, unknown> & {
  enabled?: boolean;
  bsmAccessToken?: SecretRef;
  paperclipApiToken?: SecretRef;
  paperclipSetupApiToken?: SecretRef;
  paperclipApiOrigin?: string;
  syncIntervalMinutes?: number;
  destinationScope?: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return ref.type === "secret_ref" && typeof ref.secretId === "string" && uuid.test(ref.secretId) &&
    (ref.version === undefined || ref.version === "latest" || (typeof ref.version === "number" && Number.isInteger(ref.version) && ref.version > 0));
}

export function validateConfig(config: BsmConfig, enabled = config.enabled === true): string | null {
  if (!isSecretRef(config.bsmAccessToken)) return "bsm_credential_required";
  if (!isSecretRef(config.paperclipApiToken)) return "paperclip_credential_required";
  if (!uuid.test(String(config.bsmOrganizationId ?? ""))) return "organization_invalid";
  if (!Array.isArray(config.bsmProjectIds) || config.bsmProjectIds.length === 0 ||
      config.bsmProjectIds.some((id) => typeof id !== "string" || !uuid.test(id)) ||
      new Set(config.bsmProjectIds).size !== config.bsmProjectIds.length) return "project_allowlist_invalid";
  if (config.destinationScope !== undefined && config.destinationScope !== "company") return "unsupported_destination_scope";
  const origin = config.paperclipApiOrigin;
  if (typeof origin !== "string") return "paperclip_origin_invalid";
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "paperclip_origin_invalid";
  } catch { return "paperclip_origin_invalid"; }
  if (config.bitwardenRegion !== undefined && !["US", "EU"].includes(String(config.bitwardenRegion))) return "bitwarden_region_invalid";
  if (config.syncIntervalMinutes !== undefined && (!Number.isInteger(config.syncIntervalMinutes) || config.syncIntervalMinutes < 5)) return "sync_interval_invalid";
  const prefix = config.targetSecretKeyPrefix ?? "bitwarden.";
  if (typeof prefix !== "string" || !/^[A-Za-z0-9._-]+$/.test(prefix) || prefix.length + 73 > 120) return "target_key_prefix_invalid";
  if (enabled && config.enabled !== true) return "sync_disabled";
  return null;
}

export function publicConfig(config: BsmConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["enabled", "bsmOrganizationId", "bsmProjectIds", "paperclipApiOrigin", "destinationScope", "syncIntervalMinutes", "targetSecretKeyPrefix", "archiveOnRemoval", "bitwardenRegion"]) {
    if (Object.hasOwn(config, key)) result[key] = config[key];
  }
  result.bsmAccessToken = isSecretRef(config.bsmAccessToken) ? { ...config.bsmAccessToken } : null;
  result.paperclipApiToken = isSecretRef(config.paperclipApiToken) ? { ...config.paperclipApiToken } : null;
  result.paperclipSetupApiToken = isSecretRef(config.paperclipSetupApiToken) ? { ...config.paperclipSetupApiToken } : null;
  return result;
}
