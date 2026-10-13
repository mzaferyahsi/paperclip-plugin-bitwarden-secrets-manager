import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, validateConfig, type BsmConfig } from "./config.js";
import { createAuthenticatedBitwardenSdk } from "./adapters/bitwarden.js";
import type { BsmSdk } from "./adapters/types.js";
import type { SyncCounts } from "./sync.js";
import { describeCode } from "./messages.js";

type ActorContext = { actor: { type: string; userId: string | null }; companyId: string | null };
type StoredState = {
  status?: string; errorCode?: string; warningCode?: string; lastAttemptAt?: string; lastSuccessAt?: string;
  scheduledAnchor?: string; nextEligibleAt?: string; lastDurationMs?: number; counts?: SyncCounts;
  projectNames?: Record<string, string>;
};
export type OverviewDependencies = { createSdk?: (token: string, region: "US" | "EU") => Promise<BsmSdk> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function userCompany(context: ActorContext): string | null {
  return context.actor.type === "user" && context.actor.userId && context.companyId ? context.companyId : null;
}
const scope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: "runtime" });
function millis(value: unknown): number | null {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function buildOverview(config: BsmConfig, state: StoredState, nowMs = Date.now()) {
  const enabled = config.enabled === true;
  const configError = validateConfig(config, false);
  const bsmToken = isSecretRef(config.bsmAccessToken);
  const paperclipToken = isSecretRef(config.paperclipApiToken);
  const setupToken = isSecretRef(config.paperclipSetupApiToken);
  const projects = Array.isArray(config.bsmProjectIds) ? (config.bsmProjectIds as unknown[]).filter((id): id is string => typeof id === "string")
    .map((id) => ({ id, name: state.projectNames?.[id] ?? null })) : [];
  const interval = Math.max(5, Number(config.syncIntervalMinutes ?? 15));
  const cooldownMs = millis(state.nextEligibleAt);
  const blockingCodes = ["paperclip_credential_expired_or_revoked", "paperclip_permission_denied", "configuration_required"];

  let status: "disabled" | "setup_needed" | "blocked" | "error" | "waiting" | "ok";
  let reasonCode: string | null = null;
  if (configError) { status = enabled ? "setup_needed" : "disabled"; reasonCode = configError; }
  else if (!enabled) { status = "disabled"; reasonCode = "sync_disabled"; }
  else if (state.errorCode && blockingCodes.includes(state.errorCode)) { status = "blocked"; reasonCode = state.errorCode; }
  else if (state.status === "partial" || state.errorCode) { status = "error"; reasonCode = state.errorCode ?? "remote_unavailable"; }
  else if (!state.lastAttemptAt) status = "waiting";
  else status = "ok";

  const anchor = millis(state.scheduledAnchor);
  let nextRunAt: string | null = null;
  if (enabled && !configError && !(state.errorCode && blockingCodes.includes(state.errorCode))) {
    const base = anchor === null ? nowMs : anchor + interval * 60_000;
    const next = Math.max(base, cooldownMs ?? 0);
    nextRunAt = new Date(Math.max(next, nowMs)).toISOString();
  }
  const errorCode = reasonCode === "sync_disabled" ? null : reasonCode ?? state.errorCode ?? state.warningCode ?? null;
  return {
    status,
    enabled,
    reason: describeCode(reasonCode),
    error: describeCode(errorCode),
    credentials: { bitwardenToken: bsmToken, paperclipToken, paperclipSetupToken: setupToken },
    scope: {
      organizationId: typeof config.bsmOrganizationId === "string" ? config.bsmOrganizationId : null,
      region: config.bitwardenRegion === "EU" ? "EU" : "US", projects,
      intervalMinutes: interval, archiveOnRemoval: config.archiveOnRemoval === true,
    },
    lastSync: {
      attemptedAt: state.lastAttemptAt ?? null, succeededAt: state.lastSuccessAt ?? null,
      durationMs: state.lastDurationMs ?? null, result: state.status ?? "not_run", counts: state.counts ?? null,
    },
    nextRunAt,
    checklist: [
      { id: "bsm-token", label: "Bitwarden machine access token added", done: bsmToken },
      { id: "organization", label: "Organization UUID entered", done: typeof config.bsmOrganizationId === "string" && UUID.test(config.bsmOrganizationId) },
      { id: "projects", label: "At least one project UUID entered", done: projects.length > 0 },
      { id: "paperclip-token", label: "Paperclip API token bound by an instance admin", done: paperclipToken },
      { id: "origin", label: "Paperclip origin entered", done: typeof config.paperclipApiOrigin === "string" && config.paperclipApiOrigin !== "" },
      { id: "test", label: "Connection tested", done: Boolean(state.projectNames) },
      { id: "enabled", label: "Sync enabled", done: enabled },
      { id: "first-sync", label: "First sync completed", done: Boolean(state.lastSuccessAt) },
    ],
  };
}

export function registerOverviewActions(ctx: PluginContext, dependencies: OverviewDependencies = {}) {
  ctx.actions.register("get-overview", async (_params, actionContext) => {
    const companyId = userCompany(actionContext);
    if (!companyId) return { ok: false, errorCode: "user_context_required", error: describeCode("user_context_required") };
    try {
      const config = await ctx.config.get(companyId) as BsmConfig;
      const state = (await ctx.state.get(scope(companyId)) ?? {}) as StoredState;
      return {
        ok: true, ...buildOverview(config, state),
        config: {
          bsmOrganizationId: config.bsmOrganizationId, bsmProjectIds: config.bsmProjectIds, paperclipApiOrigin: config.paperclipApiOrigin,
          syncIntervalMinutes: config.syncIntervalMinutes, targetSecretKeyPrefix: config.targetSecretKeyPrefix,
          archiveOnRemoval: config.archiveOnRemoval, bitwardenRegion: config.bitwardenRegion,
        },
      };
    } catch { return { ok: false, errorCode: "setup_failed", error: describeCode("setup_failed") }; }
  });

  ctx.actions.register("test-connection", async (_params, actionContext) => {
    const companyId = userCompany(actionContext);
    if (!companyId) return { ok: false, errorCode: "user_context_required", error: describeCode("user_context_required") };
    const fail = (code: string) => ({ ok: false, errorCode: code, error: describeCode(code) });
    try {
      const config = await ctx.config.get(companyId) as BsmConfig;
      if (!isSecretRef(config.bsmAccessToken)) return fail("bsm_credential_required");
      const organizationId = typeof config.bsmOrganizationId === "string" ? config.bsmOrganizationId : "";
      if (!organizationId) return fail("organization_invalid");
      const token = await ctx.secrets.resolve(config.bsmAccessToken, { companyId, configPath: "bsmAccessToken" });
      const sdk = await (dependencies.createSdk ?? createAuthenticatedBitwardenSdk)(token, config.bitwardenRegion === "EU" ? "EU" : "US");
      const visible = sdk.listProjects ? (await sdk.listProjects(organizationId)).filter((p) => p.organizationId === organizationId) : [];
      const selected = new Set(Array.isArray(config.bsmProjectIds) ? config.bsmProjectIds as string[] : []);
      const secrets = (await sdk.listSecretIds(organizationId)).filter((s) => s.organizationId === organizationId);
      const names: Record<string, string> = {};
      for (const project of visible) if (selected.has(project.id) && project.name) names[project.id] = project.name;
      const prior = (await ctx.state.get(scope(companyId)) ?? {}) as StoredState;
      await ctx.state.set(scope(companyId), { ...prior, projectNames: { ...(prior.projectNames ?? {}), ...names } });
      const missing = [...selected].filter((id) => !visible.some((p) => p.id === id));
      return {
        ok: true, projectCount: visible.length, secretCount: secrets.length,
        projects: visible.map((p) => ({ id: p.id, name: p.name ?? null, selected: selected.has(p.id) })),
        missingProjectIds: missing,
        note: missing.length ? "Some selected projects are not visible to this token. Check the project UUIDs and the token's project access." : null,
      };
    } catch (error) { return fail((error as { name?: string; code?: unknown })?.name === "AdapterError" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "remote_unavailable"); }
  });
}
