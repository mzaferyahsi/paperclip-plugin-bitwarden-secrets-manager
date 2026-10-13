import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, PLUGIN_ID, publicConfig, validateConfig, type BsmConfig, type SecretRef } from "./config.js";

type ActorContext = { actor: { type: string; userId: string | null }; companyId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_FIELDS = ["bsmOrganizationId", "bsmProjectIds", "paperclipApiOrigin", "destinationScope", "syncIntervalMinutes", "targetSecretKeyPrefix", "archiveOnRemoval", "bitwardenRegion"];

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

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return ["setup_credential_required", "setup_credential_rejected", "setup_permission_denied", "setup_identity_mismatch", "paperclip_origin_invalid", "native_request_failed", "config_save_failed", "secret_not_selectable", "token_required", "bsm_credential_required", "paperclip_credential_required", "settings_invalid", "operation_invalid"].includes(message) ? message : "setup_failed";
}

export function registerSettingsActions(ctx: PluginContext) {
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
      if (!isSecretRef(oldConfig.paperclipApiToken)) return { ok: false, errorCode: "paperclip_credential_required" };
      const draft = composeConfig(oldConfig, settings, isSecretRef(oldConfig.bsmAccessToken) ? oldConfig.bsmAccessToken : undefined);
      const candidate = { ...draft, bsmAccessToken: draft.bsmAccessToken ?? { type: "secret_ref" as const, secretId: "550e8400-e29b-41d4-a716-446655440000" } };
      const draftError = validateConfig(candidate, false);
      if (draftError) return { ok: false, errorCode: "settings_invalid" };
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
    if (!companyId || !actionContext.actor.userId) return { ok: false, errorCode: "user_context_required" };
    try {
      const oldConfig = await ctx.config.get(companyId) as BsmConfig;
      const { token, origin } = await authorizedSetup(ctx, companyId, actionContext.actor.userId, oldConfig);
      if (!isSecretRef(oldConfig.bsmAccessToken)) return { ok: false, errorCode: "bsm_credential_required" };
      const nextConfig = composeConfig(oldConfig, pickSettings(params.settings));
      if (validateConfig(nextConfig, false)) return { ok: false, errorCode: "settings_invalid" };
      await saveConfig(ctx, origin, token, companyId, nextConfig);
      return { ok: true, enabled: false };
    } catch (error) { return { ok: false, errorCode: errorCode(error) }; }
  });

  ctx.actions.register("select-secret", async (params, actionContext) => {
    const companyId = userCompany(actionContext, params.companyId);
    if (!companyId || !actionContext.actor.userId) return { ok: false, errorCode: "user_context_required" };
    const selectedId = params.secretId;
    if (typeof selectedId !== "string" || !UUID.test(selectedId)) return { ok: false, errorCode: "secret_not_selectable" };
    try {
      const oldConfig = await ctx.config.get(companyId) as BsmConfig;
      const { token, origin } = await authorizedSetup(ctx, companyId, actionContext.actor.userId, oldConfig);
      const rows = itemsOf(await request(ctx, origin, token, `/api/companies/${encodeURIComponent(companyId)}/secrets`));
      const selected = rows.find((x) => x.id === selectedId && x.companyId === companyId && x.status === "active");
      if (!selected) return { ok: false, errorCode: "secret_not_selectable" };
      const settings = pickSettings(params.settings);
      const version: number | "latest" = params.version === undefined || params.version === "latest" ? "latest" : Number(params.version);
      if (version !== "latest" && (!Number.isInteger(version) || version < 1)) return { ok: false, errorCode: "secret_not_selectable" };
      const nextConfig = composeConfig(oldConfig, settings, { type: "secret_ref", secretId: selectedId, version });
      const configError = validateConfig(nextConfig, false);
      if (configError && configError !== "bsm_credential_required") return { ok: false, errorCode: "settings_invalid" };
      await saveConfig(ctx, origin, token, companyId, nextConfig);
      return { ok: true, secret: { id: selectedId, name: String(selected.name ?? ""), provider: String(selected.provider ?? "unknown") }, enabled: false };
    } catch (error) { return { ok: false, errorCode: errorCode(error) }; }
  });
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
    if (Object.hasOwn(settings, field)) safe[field] = settings[field];
    else if (Object.hasOwn(existing, field)) safe[field] = existing[field];
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
    if (!isSecretRef(saved.bsmAccessToken) || saved.bsmAccessToken.secretId !== (config.bsmAccessToken as { secretId: string }).secretId) throw new Error("config_save_failed");
  } catch { throw new Error("config_save_failed"); }
}
