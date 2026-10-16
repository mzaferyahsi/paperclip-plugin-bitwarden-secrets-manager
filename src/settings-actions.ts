import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEY } from "./error-codes.js";
import { canonicalSelection, isSecretRef, normalizeSelection, PLUGIN_ID, publicConfig, validateConfig, type BsmConfig, type ProjectSelection, type SecretRef } from "./config.js";
import { createAuthenticatedBitwardenSdk } from "./adapters/bitwarden.js";
import type { BsmSdk } from "./adapters/types.js";

export type SettingsDependencies = { createSdk?: (token: string, region: "US" | "EU") => Promise<BsmSdk> };

type ActorContext = { actor: { type: string; userId: string | null }; companyId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_FIELD: Record<string, string> = {
  organization_invalid: "bsmOrganizationId", project_allowlist_invalid: "bsmProjectIds", project_selection_invalid: "bsmProjectSelections", project_selection_conflict: "bsmProjectSelections",
  secret_selection_invalid: "bsmProjectSelections", selection_unverified: "bsmProjectSelections", paperclip_origin_invalid: "paperclipApiOrigin",
  unsupported_destination_scope: "destinationScope", sync_interval_invalid: "syncIntervalMinutes",
  target_key_prefix_invalid: "targetSecretKeyPrefix", bitwarden_region_invalid: "bitwardenRegion",
};
const SELECTION_FIELDS = ["bsmProjectIds", "bsmProjectSelections"];
const SAFE_FIELDS = ["bsmOrganizationId", "bsmProjectIds", "bsmProjectSelections", "paperclipApiOrigin", "destinationScope", "syncIntervalMinutes", "targetSecretKeyPrefix", "archiveOnRemoval", "bitwardenRegion"];

function userCompany(context: ActorContext, requested?: unknown): string | null {
  if (context.actor.type !== "user" || !context.actor.userId || !context.companyId) return null;
  if (requested !== undefined && requested !== context.companyId) return null;
  return context.companyId;
}

function apiOrigin(config: BsmConfig): string | null {
  if (typeof config.paperclipApiOrigin !== "string") return null;
  try {
    const url = new URL(config.paperclipApiOrigin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

async function request(ctx: PluginContext, origin: string, token: string, path: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await ctx.http.fetch(`${origin}${path}`, {
      ...init, redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    if (!response.ok) throw new Error(response.status === 401 ? "setup_credential_rejected" : response.status === 403 ? "setup_permission_denied" : "native_request_failed");
    const responseText = await response.text();
    return responseText ? JSON.parse(responseText) as unknown : null;
  } finally { clearTimeout(timer); }
}

function itemsOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    for (const key of ["secrets", "items", "data"]) if (Array.isArray(row[key])) return itemsOf(row[key]);
  }
  return [];
}

async function authorizedSetup(ctx: PluginContext, companyId: string, actorUserId: string, config: BsmConfig) {
  if (!isSecretRef(config.paperclipSetupApiToken)) throw new Error("setup_credential_required");
  const origin = apiOrigin(config);
  if (!origin) throw new Error("paperclip_origin_invalid");
  const token = await ctx.secrets.resolve(config.paperclipSetupApiToken, { companyId, configPath: "paperclipSetupApiToken" });
  const identity = await request(ctx, origin, token, "/api/cli-auth/me") as Record<string, unknown>;
  const companies = Array.isArray(identity.companyIds) ? identity.companyIds :
    Array.isArray(identity.companies) ? identity.companies.map((x) => typeof x === "object" && x ? (x as Record<string, unknown>).id ?? (x as Record<string, unknown>).companyId : null) : [];
  if (identity.userId !== actorUserId || identity.isInstanceAdmin !== true || !companies.includes(companyId)) throw new Error("setup_identity_mismatch");
  return { token, origin };
}

/** The runtime ref is what the origin receives credentials for; once bound, the page cannot repoint it (security-review S2b). */
function originChangeRefused(existing: BsmConfig, settings: Record<string, unknown>): boolean {
  return isSecretRef(existing.paperclipApiToken) && Object.hasOwn(settings, "paperclipApiOrigin") && settings.paperclipApiOrigin !== existing.paperclipApiOrigin;
}

function rejection(code: string) { return { ok: false, errorCode: code, field: CODE_FIELD[code] ?? null }; }

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return ["setup_credential_required", "setup_credential_rejected", "setup_permission_denied", "setup_identity_mismatch", "paperclip_origin_invalid", "native_request_failed", "config_save_failed", "secret_not_selectable", "secret_selection_invalid", "selection_unverified", "token_required", "bsm_credential_required", "paperclip_credential_required", "settings_invalid", "operation_invalid"].includes(message) ? message : "setup_failed";
}

export function registerSettingsActions(ctx: PluginContext, dependencies: SettingsDependencies = {}) {
  const verify = (config: BsmConfig, old: BsmConfig, token: () => Promise<string>) => verifySelection(dependencies, config, old, token);
  ctx.actions.register("get-settings", async (_params, actionContext) => {
    const companyId = userCompany(actionContext);
    if (!companyId || !actionContext.actor.userId) return { ok: false, errorCode: "user_context_required" };
    try {
      const config = await ctx.config.get(companyId) as BsmConfig;
      await authorizedSetup(ctx, companyId, actionContext.actor.userId, config);
      return { ok: true, config: publicConfig(config) };
    } catch (error) { return { ok: false, errorCode: errorCode(error) }; }
  });

  ctx.actions.register("list-secrets", async (params, actionContext) => {
    const companyId = userCompany(actionContext, params.companyId);
    if (!companyId || !actionContext.actor.userId) return { ok: false, errorCode: "user_context_required" };
    try {
      const config = await ctx.config.get(companyId) as BsmConfig;
      const { token, origin } = await authorizedSetup(ctx, companyId, actionContext.actor.userId, config);
      const rows = itemsOf(await request(ctx, origin, token, `/api/companies/${encodeURIComponent(companyId)}/secrets`));
      const secrets = rows.filter((x) => x.companyId === companyId && x.status === "active" && typeof x.id === "string")
        .map((x) => ({ id: x.id, name: String(x.name ?? ""), key: String(x.key ?? ""), provider: String(x.provider ?? "unknown"), status: String(x.status ?? "active"), latestVersion: x.latestVersion ?? null }));
      return { ok: true, secrets };
    } catch (error) { return { ok: false, errorCode: errorCode(error) }; }
  });

  ctx.actions.register("save-token", async (params, actionContext) => {
    const companyId = userCompany(actionContext, params.companyId);
    if (!companyId || !actionContext.actor.userId) return { ok: false, errorCode: "user_context_required" };
    const tokenValue = params.token;
    if (typeof tokenValue !== "string" || !tokenValue.trim()) return { ok: false, errorCode: "token_required" };
    if (typeof params.operationId !== "string" || !UUID.test(params.operationId)) return { ok: false, errorCode: "operation_invalid" };
    try {
      const oldConfig = await ctx.config.get(companyId) as BsmConfig;
      const { token, origin } = await authorizedSetup(ctx, companyId, actionContext.actor.userId, oldConfig);
      const settings = pickSettings(params.settings);
      if (originChangeRefused(oldConfig, settings)) return { ok: false, errorCode: "paperclip_origin_invalid" };
      if (!isSecretRef(oldConfig.paperclipApiToken)) return { ok: false, errorCode: "paperclip_credential_required" };
      const draft = composeConfig(oldConfig, settings, isSecretRef(oldConfig.bsmAccessToken) ? oldConfig.bsmAccessToken : undefined);
      const candidate = { ...draft, bsmAccessToken: draft.bsmAccessToken ?? { type: "secret_ref" as const, secretId: "550e8400-e29b-41d4-a716-446655440000" } };
      const draftError = validateConfig(candidate, false);
      if (draftError) return { ok: false, errorCode: SELECTION_CODES.has(draftError) ? draftError : "settings_invalid" };
      const unverified = await verify(draft, oldConfig, async () => tokenValue);
      if (unverified) return { ok: false, errorCode: unverified };
      const newRef = await createTokenSecret(ctx, origin, token, companyId, params.operationId, tokenValue);
      const nextConfig = composeConfig(oldConfig, settings, newRef);
      const configError = validateConfig(nextConfig, false);
      if (configError && !["bsm_credential_required"].includes(configError)) return { ok: false, errorCode: "settings_invalid", secretId: newRef.secretId };
      try { await saveConfig(ctx, origin, token, companyId, nextConfig); }
      catch { return { ok: false, errorCode: "config_save_failed", secret: { id: newRef.secretId } }; }
      return { ok: true, secret: { id: newRef.secretId }, enabled: false };
    } catch (error) { return { ok: false, errorCode: errorCode(error) }; }
    finally { /* transient token is not copied into config, state, or output */ }
  });

  ctx.actions.register("save-settings", async (params, actionContext) => {
    const companyId = userCompany(actionContext, params.companyId);
    if (!companyId || !actionContext.actor.userId) return rejection("user_context_required");
    try {
      const oldConfig = await ctx.config.get(companyId) as BsmConfig;
      const { token, origin } = await authorizedSetup(ctx, companyId, actionContext.actor.userId, oldConfig);
      if (!isSecretRef(oldConfig.bsmAccessToken)) return rejection("bsm_credential_required");
      const settings = pickSettings(params.settings);
      if (originChangeRefused(oldConfig, settings)) return rejection("paperclip_origin_invalid");
      const nextConfig = composeConfig(oldConfig, settings);
      const invalid = validateConfig(nextConfig, false);
      if (invalid) return rejection(CODE_FIELD[invalid] ? invalid : "settings_invalid");
      const unverified = await verify(nextConfig, oldConfig, () => ctx.secrets.resolve(nextConfig.bsmAccessToken as SecretRef, { companyId, configPath: "bsmAccessToken" }));
      if (unverified) return rejection(unverified);
      await saveConfig(ctx, origin, token, companyId, nextConfig);
      return { ok: true, errorCode: null, field: null, enabled: false };
    } catch (error) { return rejection(errorCode(error)); }
  });

  ctx.actions.register("set-enabled", async (params, actionContext) => {
    const companyId = userCompany(actionContext, params.companyId);
    if (!companyId || !actionContext.actor.userId) return rejection("user_context_required");
    if (typeof params.enabled !== "boolean") return rejection("settings_invalid");
    try {
      const oldConfig = await ctx.config.get(companyId) as BsmConfig;
      const { token, origin } = await authorizedSetup(ctx, companyId, actionContext.actor.userId, oldConfig);
      if (params.enabled) {
        const invalid = validateConfig(oldConfig, false);
        if (invalid) return rejection(invalid);
        if (!isSecretRef(oldConfig.bsmAccessToken)) return rejection("bsm_credential_required");
        if (!isSecretRef(oldConfig.paperclipApiToken)) return rejection("paperclip_credential_required");
      }
      const nextConfig = composeConfig(oldConfig, {});
      nextConfig.enabled = params.enabled;
      await saveConfig(ctx, origin, token, companyId, nextConfig);
      if (params.enabled && oldConfig.enabled !== true) {
        // Enabling is the operator re-arm: drop a stale block so the next run retries.
        const scope = { scopeKind: "company" as const, scopeId: companyId, stateKey: STATE_KEY };
        const prior = await ctx.state.get(scope) as Record<string, unknown> | null;
        if (prior && (prior.errorCode !== undefined || prior.nextEligibleAt !== undefined)) {
          const { errorCode: _e, nextEligibleAt: _n, ...rest } = prior;
          await ctx.state.set(scope, rest);
        }
      }
      return { ok: true, errorCode: null, field: null, enabled: params.enabled };
    } catch (error) { return rejection(errorCode(error)); }
  });

  ctx.actions.register("select-secret", async (params, actionContext) => {
    const companyId = userCompany(actionContext, params.companyId);
    if (!companyId || !actionContext.actor.userId) return { ok: false, errorCode: "user_context_required" };
    const selectedId = params.secretId;
    if (typeof selectedId !== "string" || !UUID.test(selectedId)) return { ok: false, errorCode: "secret_not_selectable" };
    try {
      const oldConfig = await ctx.config.get(companyId) as BsmConfig;
      const { token, origin } = await authorizedSetup(ctx, companyId, actionContext.actor.userId, oldConfig);
      const settings = pickSettings(params.settings);
      if (originChangeRefused(oldConfig, settings)) return { ok: false, errorCode: "paperclip_origin_invalid" };
      const rows = itemsOf(await request(ctx, origin, token, `/api/companies/${encodeURIComponent(companyId)}/secrets`));
      const selected = rows.find((x) => x.id === selectedId && x.companyId === companyId && x.status === "active");
      if (!selected) return { ok: false, errorCode: "secret_not_selectable" };
      const version: number | "latest" = params.version === undefined || params.version === "latest" ? "latest" : Number(params.version);
      if (version !== "latest" && (!Number.isInteger(version) || version < 1)) return { ok: false, errorCode: "secret_not_selectable" };
      const nextConfig = composeConfig(oldConfig, settings, { type: "secret_ref", secretId: selectedId, version });
      const configError = validateConfig(nextConfig, false);
      if (configError && configError !== "bsm_credential_required") return { ok: false, errorCode: SELECTION_CODES.has(configError) ? configError : "settings_invalid" };
      const unverified = await verify(nextConfig, oldConfig, () => ctx.secrets.resolve(nextConfig.bsmAccessToken as SecretRef, { companyId, configPath: "bsmAccessToken" }));
      if (unverified) return { ok: false, errorCode: unverified };
      await saveConfig(ctx, origin, token, companyId, nextConfig);
      return { ok: true, secret: { id: selectedId, name: String(selected.name ?? ""), provider: String(selected.provider ?? "unknown") }, enabled: false };
    } catch (error) { return { ok: false, errorCode: errorCode(error) }; }
  });
}

const SELECTION_CODES = new Set(["project_allowlist_invalid", "project_selection_invalid", "project_selection_conflict"]);

const sameSelection = (a: BsmConfig, b: BsmConfig) => {
  const left = normalizeSelection(a), right = normalizeSelection(b);
  return left.ok && right.ok && JSON.stringify(canonicalSelection(left.entries)) === JSON.stringify(canonicalSelection(right.entries));
};

/**
 * Selected-secret entries are checked against Bitwarden metadata before they are saved: each project must be
 * visible and each ID must be listed. No secret value is read. Project membership is not available as
 * metadata on the current SDK, so selected and whole-project sync both fail closed before any value read
 * (project_membership_unavailable). With membership metadata, sync rejects out-of-project IDs before fetching.
 * Unverifiable means rejected. Unchanged selections are not re-checked, so token rotation never depends on it.
 */
async function verifySelection(dependencies: SettingsDependencies, next: BsmConfig, old: BsmConfig, getToken: () => Promise<string>): Promise<string | null> {
  const selection = normalizeSelection(next);
  if (!selection.ok) return selection.code;
  const selected = selection.entries.filter((e): e is Extract<ProjectSelection, { mode: "selected" }> => e.mode === "selected");
  if (selected.length === 0 || sameSelection(next, old)) return null;
  try {
    const org = String(next.bsmOrganizationId);
    const sdk = await (dependencies.createSdk ?? createAuthenticatedBitwardenSdk)(await getToken(), next.bitwardenRegion === "EU" ? "EU" : "US");
    if (sdk.listProjects) {
      const visible = new Set((await sdk.listProjects(org)).filter((p) => p.organizationId === org).map((p) => p.id.toLowerCase()));
      if (selection.entries.some((e) => !visible.has(e.projectId.toLowerCase()))) return "project_selection_invalid";
    }
    const listed = new Set((await sdk.listSecretIds(org)).filter((s) => s.organizationId === org).map((s) => s.id.toLowerCase()));
    if (selected.flatMap((e) => e.secretIds).some((id) => !listed.has(id.toLowerCase()))) return "secret_selection_invalid";
    return null;
  } catch { return "selection_unverified"; }
}

function pickSettings(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("settings_invalid");
  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of SAFE_FIELDS) if (Object.hasOwn(source, field)) result[field] = source[field];
  return result;
}

function composeConfig(existing: BsmConfig, settings: Record<string, unknown>, bsmRef?: SecretRef): BsmConfig {
  const safe: BsmConfig = { enabled: false, destinationScope: "company" };
  for (const field of SAFE_FIELDS) {
    if (SELECTION_FIELDS.includes(field)) continue;
    if (Object.hasOwn(settings, field)) safe[field] = settings[field];
    else if (Object.hasOwn(existing, field)) safe[field] = existing[field];
  }
  // Scope: the form named in the request wins and the other is dropped (explicit migration).
  // Submitting both is kept as-is so validation rejects the conflict instead of picking one.
  const requested = SELECTION_FIELDS.filter((field) => Object.hasOwn(settings, field));
  for (const field of requested.length ? requested : SELECTION_FIELDS) {
    const source = requested.length ? settings : existing;
    if (Object.hasOwn(source, field)) safe[field] = source[field];
  }
  if (isSecretRef(existing.paperclipApiToken)) safe.paperclipApiToken = { ...existing.paperclipApiToken };
  if (isSecretRef(existing.paperclipSetupApiToken)) safe.paperclipSetupApiToken = { ...existing.paperclipSetupApiToken };
  if (bsmRef) safe.bsmAccessToken = { ...bsmRef };
  else if (isSecretRef(existing.bsmAccessToken)) safe.bsmAccessToken = { ...existing.bsmAccessToken };
  return safe;
}

async function createTokenSecret(ctx: PluginContext, origin: string, setupToken: string, companyId: string, operationId: string, tokenValue: string): Promise<SecretRef> {
  const key = `bitwarden.bootstrap.${PLUGIN_ID}.${operationId}`;
  let payload: Record<string, unknown>;
  try {
    payload = await request(ctx, origin, setupToken, `/api/companies/${encodeURIComponent(companyId)}/secrets`, {
      method: "POST", body: JSON.stringify({
        name: `Bitwarden bootstrap ${operationId.slice(0, 8)}`, key,
        provider: "local_encrypted", managedMode: "paperclip_managed", value: tokenValue,
      }),
    }) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && ["setup_credential_rejected", "setup_permission_denied"].includes(error.message)) throw error;
    const rows = itemsOf(await request(ctx, origin, setupToken, `/api/companies/${encodeURIComponent(companyId)}/secrets`));
    const existing = rows.find((row) => row.key === key && row.companyId === companyId && row.provider === "local_encrypted" && row.status === "active");
    if (!existing || typeof existing.id !== "string") throw new Error("native_request_failed");
    return { type: "secret_ref", secretId: existing.id, version: "latest" };
  }
  if (!payload || typeof payload !== "object") throw new Error("native_request_failed");
  const id = typeof payload.id === "string" ? payload.id : typeof (payload.secret as Record<string, unknown> | undefined)?.id === "string" ? ((payload.secret as Record<string, unknown>).id as string) : null;
  if (!id || !UUID.test(id)) throw new Error("native_request_failed");
  return { type: "secret_ref" as const, secretId: id, version: "latest" };
}

async function saveConfig(ctx: PluginContext, origin: string, setupToken: string, companyId: string, config: BsmConfig) {
  try {
    await request(ctx, origin, setupToken, `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/config`, {
      method: "POST", body: JSON.stringify({ companyId, configJson: config }),
    });
    const saved = await ctx.config.get(companyId) as BsmConfig;
    const expected = isSecretRef(config.bsmAccessToken) ? config.bsmAccessToken.secretId : null;
    if (saved.enabled !== config.enabled || (expected !== null && (!isSecretRef(saved.bsmAccessToken) || saved.bsmAccessToken.secretId !== expected))) throw new Error("config_save_failed");
  } catch { throw new Error("config_save_failed"); }
}
