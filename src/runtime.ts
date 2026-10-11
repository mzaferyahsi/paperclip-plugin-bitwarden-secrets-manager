import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, validateConfig, type BsmConfig } from "./config.js";

const STATE_KEY = "runtime";
const RUN_BUDGET_MS = 4 * 60_000;
const MAX_COMPANIES = 500;
const COMPANY_PAGE_SIZE = 100;
type State = {
  generation?: number; scheduledAnchor?: string; nextEligibleAt?: string;
  lastAttemptAt?: string; lastSuccessAt?: string; status?: string; errorCode?: string;
  warningCode?: string;
  runtimeRefIds?: string[];
  processedCompanies?: number;
};

function stateScope(companyId: string) { return { scopeKind: "company" as const, scopeId: companyId, stateKey: STATE_KEY }; }
function dateMillis(input: unknown): number | null {
  const n = typeof input === "string" ? Date.parse(input) : NaN;
  return Number.isFinite(n) ? n : null;
}

let mutexHeld = false;
async function withRunLock<T>(fn: () => Promise<T>): Promise<T | { status: "already_running" }> {
  if (mutexHeld) return { status: "already_running" };
  mutexHeld = true;
  try { return await fn(); }
  finally { mutexHeld = false; }
}

async function writeStatus(ctx: PluginContext, companyId: string, patch: Partial<State>) {
  const prior = (await ctx.state.get(stateScope(companyId)) ?? {}) as State;
  await ctx.state.set(stateScope(companyId), { ...prior, ...patch });
}

async function syncCompanies(ctx: PluginContext, job: PluginJobContext | null, onlyCompanyId?: string) {
  const started = Date.now();
  const scheduledAt = job?.scheduledAt ?? new Date(started).toISOString();
  const scheduledMs = dateMillis(scheduledAt) ?? started;
  const intervalMs = 15 * 60_000;
  let selected;
  let companyListTruncated = false;
  if (onlyCompanyId) {
    const company = await ctx.companies.get(onlyCompanyId);
    selected = company ? [company] : [];
  } else {
    selected = [];
    for (let offset = 0; offset < MAX_COMPANIES; offset += COMPANY_PAGE_SIZE) {
      const page = await ctx.companies.list({ limit: COMPANY_PAGE_SIZE, offset });
      selected.push(...page);
      if (page.length < COMPANY_PAGE_SIZE) break;
      if (offset + page.length >= MAX_COMPANIES) companyListTruncated = true;
    }
  }
  let processed = 0;
  for (const company of selected) {
    if (Date.now() - started >= RUN_BUDGET_MS) break;
    const companyId = company.id;
    const config = await ctx.config.get(companyId) as BsmConfig;
    if (config.enabled !== true) continue;
    let state = (await ctx.state.get(stateScope(companyId)) ?? {}) as State;
    const currentRefs = [config.bsmAccessToken, config.paperclipApiToken].map((ref) => isSecretRef(ref) ? ref.secretId : "invalid");
    if (state.runtimeRefIds && (state.runtimeRefIds[0] !== currentRefs[0] || state.runtimeRefIds[1] !== currentRefs[1])) {
      state = { ...state, errorCode: undefined, nextEligibleAt: undefined, runtimeRefIds: currentRefs };
      await ctx.state.set(stateScope(companyId), state);
    } else if (!state.runtimeRefIds) {
      state = { ...state, runtimeRefIds: currentRefs };
      await ctx.state.set(stateScope(companyId), state);
    }
    const dueAt = dateMillis(state.nextEligibleAt);
    if (state.errorCode && dueAt !== null && Date.now() < dueAt) {
      await writeStatus(ctx, companyId, { status: "credential_cooldown" });
      continue;
    }
    if (job?.trigger === "schedule") {
      const interval = Math.max(5, Number(config.syncIntervalMinutes ?? 15)) * 60_000;
      const anchor = dateMillis(state.scheduledAnchor);
      const next = anchor === null ? null : anchor + interval;
      const now = Date.now();
      const anchorCorrupt = anchor !== null && anchor - now > interval;
      const nextEligibleAt = dateMillis(state.nextEligibleAt);
      const nextEligibilityCorrupt = !state.errorCode && nextEligibleAt !== null && nextEligibleAt - now > interval;
      if (anchorCorrupt || nextEligibilityCorrupt) {
        await writeStatus(ctx, companyId, {
          warningCode: "clock_anchor_reset", scheduledAnchor: scheduledAt,
          ...(nextEligibilityCorrupt ? { nextEligibleAt: undefined } : {}),
        });
        await ctx.activity.log({ companyId, message: "Scheduled cadence was reset after a backwards clock step.", entityType: "company", entityId: companyId, metadata: { code: "clock_anchor_reset" } });
      } else if (next !== null && scheduledMs < next - 60_000) {
        await writeStatus(ctx, companyId, { status: "skipped_early_tick" });
        continue;
      }
      await writeStatus(ctx, companyId, { scheduledAnchor: scheduledAt });
    }
    const configError = validateConfig(config);
    const attemptAt = new Date().toISOString();
    if (configError) {
      await writeStatus(ctx, companyId, { lastAttemptAt: attemptAt, status: "configuration_required", errorCode: configError });
      continue;
    }
    // Adapter and sync application are integrated by the assigned adapter/integration stages.
    // This package shell validates bound refs without reading or persisting their values.
    if (!isSecretRef(config.bsmAccessToken) || !isSecretRef(config.paperclipApiToken)) continue;
    try {
      await ctx.secrets.resolve(config.bsmAccessToken, { companyId, configPath: "bsmAccessToken" });
      await ctx.secrets.resolve(config.paperclipApiToken, { companyId, configPath: "paperclipApiToken" });
      await writeStatus(ctx, companyId, { lastAttemptAt: attemptAt, status: "credentials_ready", errorCode: undefined, runtimeRefIds: currentRefs });
    } catch {
      await writeStatus(ctx, companyId, { lastAttemptAt: attemptAt, status: "configuration_required", errorCode: "credential_unavailable" });
      continue;
    }
    processed += 1;
    await ctx.activity.log({ companyId, message: "Bitwarden sync credentials are available.", entityType: "company", entityId: companyId, metadata: { status: "credentials_ready" } });
  }
  return { status: Date.now() - started >= RUN_BUDGET_MS || companyListTruncated ? "partial" : "ok", processedCompanies: processed };
}

export function registerRuntime(ctx: PluginContext) {
  ctx.jobs.register("bsm-sync", async (job) => {
    await withRunLock(async () => { await syncCompanies(ctx, job); return { status: "ok" }; });
  });
  ctx.data.register("worker-health", async () => ({ status: "available" }));
  ctx.actions.register("get-status", async (_params, actionContext) => {
    const actor = actionContext.actor;
    const companyId = actionContext.companyId;
    if (actor.type !== "user" || !actor.userId || !companyId) return { status: "denied", errorCode: "user_context_required" };
    const state = (await ctx.state.get(stateScope(companyId)) ?? {}) as State;
    return {
      status: state.status ?? "not_run", errorCode: state.errorCode ?? state.warningCode ?? null,
      lastAttemptAt: state.lastAttemptAt ?? null, lastSuccessAt: state.lastSuccessAt ?? null,
      processedCompanies: state.processedCompanies ?? 0,
    };
  });
  ctx.actions.register("resync", async (_params, actionContext) => {
    const actor = actionContext.actor;
    if (actor.type !== "user" || !actor.userId || !actionContext.companyId) return { status: "denied", errorCode: "user_context_required" };
    return withRunLock(async () => syncCompanies(ctx, null, actionContext.companyId!));
  });
}
