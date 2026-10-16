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

export type ProjectSelection =
  | { projectId: string; mode: "all" }
  | { projectId: string; mode: "selected"; secretIds: string[] };
export const MAX_SELECTED_SECRETS = 500;
/** Internal stand-ins that keep the persisted shape unchanged. Real Bitwarden project IDs are random v4 UUIDs. */
export const ALL_SECRETS_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
export const NO_PROJECT_ID = "00000000-0000-4000-8000-000000000000";
export const isAllSecrets = (entries: readonly ProjectSelection[]) => entries.some((e) => e.projectId.toLowerCase() === ALL_SECRETS_ID);
export const isRealProject = (projectId: string) => ![ALL_SECRETS_ID, NO_PROJECT_ID].includes(projectId.toLowerCase());
export type SelectionResult =
  | { ok: true; entries: ProjectSelection[]; legacy: boolean }
  | { ok: false; code: "project_allowlist_invalid" | "project_selection_invalid" | "project_selection_conflict" };

/**
 * Canonical scope is a union of per-project entries. The legacy `bsmProjectIds` list means
 * whole-project selection and is only read, never written, by new saves. Anything malformed
 * fails closed; there is no implicit whole-organization fallback.
 */
export function normalizeSelection(config: Record<string, unknown>): SelectionResult {
  const hasNew = config.bsmProjectSelections !== undefined;
  const legacyList = config.bsmProjectIds;
  const hasLegacy = legacyList !== undefined;
  if (hasNew && hasLegacy) return { ok: false, code: "project_selection_conflict" };
  if (!hasNew) {
    if (!Array.isArray(legacyList) || legacyList.length === 0 ||
        legacyList.some((id) => typeof id !== "string" || !uuid.test(id)) || new Set(legacyList.map((id) => String(id).toLowerCase())).size !== legacyList.length) {
      return { ok: false, code: "project_allowlist_invalid" };
    }
    return { ok: true, legacy: true, entries: (legacyList as string[]).map((projectId) => ({ projectId, mode: "all" as const })) };
  }
  const input = config.bsmProjectSelections;
  if (!Array.isArray(input) || input.length === 0) return { ok: false, code: "project_selection_invalid" };
  const entries: ProjectSelection[] = [];
  const projects = new Set<string>();
  const secrets = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "project_selection_invalid" };
    const row = raw as Record<string, unknown>;
    if (typeof row.projectId !== "string" || !uuid.test(row.projectId)) return { ok: false, code: "project_selection_invalid" };
    const key = row.projectId.toLowerCase();
    if (projects.has(key)) return { ok: false, code: "project_selection_invalid" };
    projects.add(key);
    if (row.mode === "all") {
      if (Object.keys(row).some((k) => k !== "projectId" && k !== "mode")) return { ok: false, code: "project_selection_invalid" };
      entries.push({ projectId: row.projectId, mode: "all" });
    } else if (row.mode === "selected") {
      if (Object.keys(row).some((k) => !["projectId", "mode", "secretIds"].includes(k))) return { ok: false, code: "project_selection_invalid" };
      const ids = row.secretIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !uuid.test(id))) return { ok: false, code: "project_selection_invalid" };
      for (const id of ids as string[]) {
        const lower = id.toLowerCase();
        if (secrets.has(lower)) return { ok: false, code: "project_selection_invalid" };
        secrets.add(lower);
      }
      if (secrets.size > MAX_SELECTED_SECRETS) return { ok: false, code: "project_selection_invalid" };
      entries.push({ projectId: row.projectId, mode: "selected", secretIds: [...ids as string[]] });
    } else return { ok: false, code: "project_selection_invalid" };
  }
  // "All secrets" stands alone: mixing it with other entries is ambiguous, so it fails closed.
  if (projects.has(ALL_SECRETS_ID) && (entries.length !== 1 || entries[0].mode !== "all")) return { ok: false, code: "project_selection_invalid" };
  return { ok: true, legacy: false, entries };
}

/** Does the selection admit this secret, judged by the project it actually belongs to? */
export function selectionAdmits(entries: readonly ProjectSelection[], projectId: string | null | undefined, secretId: string): boolean {
  if (!projectId) return false;
  if (isAllSecrets(entries)) return true;
  const entry = entries.find((e) => e.projectId.toLowerCase() === projectId.toLowerCase());
  if (!entry) return false;
  return entry.mode === "all" || entry.secretIds.some((id) => id.toLowerCase() === secretId.toLowerCase());
}

/** Order-independent form for scope fingerprints; legacy and equivalent all-entries match. */
export function canonicalSelection(entries: readonly ProjectSelection[]) {
  return [...entries].map((e) => e.mode === "all" ? { p: e.projectId.toLowerCase(), m: "all" } :
    { p: e.projectId.toLowerCase(), m: "selected", s: e.secretIds.map((id) => id.toLowerCase()).sort() })
    .sort((a, b) => a.p < b.p ? -1 : 1);
}

export function validateConfig(config: BsmConfig, enabled = config.enabled === true): string | null {
  if (!isSecretRef(config.bsmAccessToken)) return "bsm_credential_required";
  if (!isSecretRef(config.paperclipApiToken)) return "paperclip_credential_required";
  if (!uuid.test(String(config.bsmOrganizationId ?? ""))) return "organization_invalid";
  const selection = normalizeSelection(config);
  if (!selection.ok) return selection.code;
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
  for (const key of ["enabled", "bsmOrganizationId", "bsmProjectIds", "bsmProjectSelections", "paperclipApiOrigin", "destinationScope", "syncIntervalMinutes", "targetSecretKeyPrefix", "archiveOnRemoval", "bitwardenRegion"]) {
    if (Object.hasOwn(config, key)) result[key] = config[key];
  }
  result.bsmAccessToken = isSecretRef(config.bsmAccessToken) ? { ...config.bsmAccessToken } : null;
  result.paperclipApiToken = isSecretRef(config.paperclipApiToken) ? { ...config.paperclipApiToken } : null;
  result.paperclipSetupApiToken = isSecretRef(config.paperclipSetupApiToken) ? { ...config.paperclipSetupApiToken } : null;
  return result;
}
