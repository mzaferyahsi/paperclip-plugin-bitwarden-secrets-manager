import { PLUGIN_RPC_ERROR_CODES, type PluginContext, type PluginJobContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, validateConfig, type BsmConfig } from "./config.js";
import { createAuthenticatedBitwardenSdk } from "./adapters/bitwarden.js";
import { AdapterError, type HttpRequest, type HttpResponse, type HttpTransport } from "./adapters/types.js";
import { PaperclipSecretsAdapter } from "./adapters/paperclip.js";
import { AUTHORIZATION_BLOCKED } from "./error-codes.js";
import { syncCompany, type SyncState } from "./sync.js";
import type { BsmSdk } from "./adapters/types.js";

const STATE_KEY = "runtime";
const RUN_BUDGET_MS = 4 * 60_000;
const MAX_COMPANIES = 500;
const COMPANY_PAGE_SIZE = 100;
type State = {
  generation?: number; scheduledAnchor?: string; nextEligibleAt?: string;
  lastAttemptAt?: string; lastSuccessAt?: string; status?: string; errorCode?: string;
  warningCode?: string;
  runtimeRefIds?: string[];
  configFingerprint?: string;
  itemJournal?: SyncState["itemJournal"];
  destinationVersions?: Record<string, number>;
  absenceEvidence?: SyncState["absenceEvidence"];
  lastRunSummary?: SyncState["lastRunSummary"];
};

// Matched by name, not instanceof: the bundled SDK copy is not the class the host runtime throws.
function isErrorNamed(error: unknown, name: string) { return error instanceof Error && error.name === name; }
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

async function syncCompanies(ctx: PluginContext, job: PluginJobContext | null, onlyCompanyId?: string,
  explicitManual = job === null || job?.trigger === "manual", dependencies: RuntimeDependencies = {}) {
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
  let denied = 0;
  let configured = 0;
  let enabled = 0;
  for (const company of selected) {
    if (Date.now() - started >= RUN_BUDGET_MS) break;
    const companyId = company.id;
    // Host 2026.1012.0 admits config.get(companyId) from a job only for companies that already
    // have a stored plugin config row; any other company is denied. Treat denial as "unconfigured".
    let config: BsmConfig;
    try { config = await ctx.config.get(companyId) as BsmConfig; }
    catch (error) {
      if (isErrorNamed(error, "JsonRpcCallError") && (error as { code?: unknown }).code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED) { denied++; continue; }
      ctx.logger.error("config.get failed unexpectedly", { companyId, code: (error as { code?: unknown })?.code });
      throw error;
    }
    configured++;
    if (config.enabled !== true) continue;
    enabled++;
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
    const authorizationBlocked = state.errorCode !== undefined && AUTHORIZATION_BLOCKED.has(state.errorCode);
    if (authorizationBlocked && !explicitManual) {
      await writeStatus(ctx, companyId, { status: "configuration_required" });
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
        state = { ...state, warningCode: "clock_anchor_reset", scheduledAnchor: scheduledAt,
          ...(nextEligibilityCorrupt ? { nextEligibleAt: undefined } : {}) };
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
    if (!isSecretRef(config.bsmAccessToken) || !isSecretRef(config.paperclipApiToken)) continue;
    try {
      const [bsmToken, paperclipToken] = await Promise.all([
        ctx.secrets.resolve(config.bsmAccessToken, { companyId, configPath: "bsmAccessToken" }),
        ctx.secrets.resolve(config.paperclipApiToken, { companyId, configPath: "paperclipApiToken" }),
      ]);
      const sdk = await (dependencies.createSdk ?? createAuthenticatedBitwardenSdk)(bsmToken, config.bitwardenRegion === "EU" ? "EU" : "US");
      const transport = (dependencies.createTransport ?? nativeTransport)(ctx, config.paperclipApiOrigin!, paperclipToken);
      const previousState = state as SyncState;
      const updated = await syncCompany(config, {
        sdk,
        native: new PaperclipSecretsAdapter(transport, companyId),
        previousState,
        stateFingerprint: previousState.configFingerprint,
        generation: previousState.generation,
        destinationVersions: previousState.destinationVersions,
        absenceEvidence: previousState.absenceEvidence,
        now: Date.now,
        deadlineAt: started + RUN_BUDGET_MS,
        save: async next => {
          await ctx.state.set(stateScope(companyId), {
            ...next, runtimeRefIds: currentRefs,
          });
        },
      });
      state = updated;
      processed += 1;
      const skippedArchived = updated.lastRunSummary?.skippedArchived ?? 0;
      if (skippedArchived > 0) {
        await ctx.activity.log({
          companyId, message: "Archived Bitwarden sources reappeared and were not restored.", entityType: "company", entityId: companyId,
          metadata: { code: "archived_source_reappeared", count: skippedArchived },
        });
      }
      await ctx.activity.log({
        companyId, message: "Bitwarden sync finished with sanitized status.", entityType: "company", entityId: companyId,
        metadata: { status: updated.status, errorCode: updated.errorCode ?? null, generation: updated.generation },
      });
    } catch (error) {
      const errorCode = error instanceof AdapterError ? error.code : "remote_unavailable";
      const retryAfter = error instanceof AdapterError ? error.retryAfterMs : undefined;
      const backoff = errorCode === "paperclip_rate_limited" ? Math.min(60 * 60_000, Math.max(60_000, retryAfter ?? 5 * 60_000)) :
        ["remote_unavailable", "paperclip_unavailable", "ambiguous_write"].includes(errorCode) ? Math.min(60 * 60_000, 60_000 * (2 ** Math.min(6, Number(state.generation ?? 0)))) : undefined;
      await writeStatus(ctx, companyId, {
        lastAttemptAt: attemptAt, status: AUTHORIZATION_BLOCKED.has(errorCode) || errorCode.startsWith("paperclip_credential") ? "configuration_required" : "partial",
        errorCode, ...(backoff ? { nextEligibleAt: new Date(Date.now() + backoff).toISOString() } : {}),
      });
      await ctx.activity.log({ companyId, message: "Bitwarden sync stopped with a sanitized error.", entityType: "company", entityId: companyId, metadata: { errorCode } });
    }
  }
  const summary = { companies: selected.length, configured, enabled, denied, processed };
  if (!onlyCompanyId) {
    if (selected.length > 0 && denied === selected.length) ctx.logger.warn("scheduled sync: config.get denied for every company", summary);
    else ctx.logger.info("scheduled sync summary", summary);
  }
  return { status: Date.now() - started >= RUN_BUDGET_MS || companyListTruncated ? "partial" : "ok", processedCompanies: processed, ...summary };
}

export { AdapterError };
export type RuntimeDependencies = {
  createSdk?: (token: string, region: "US" | "EU") => Promise<BsmSdk>;
  createTransport?: (ctx: PluginContext, origin: string, token: string) => HttpTransport;
};

export function registerRuntime(ctx: PluginContext, dependencies: RuntimeDependencies = {}) {
  ctx.jobs.register("bsm-sync", async (job) => {
    await withRunLock(async () => syncCompanies(ctx, job, undefined, job.trigger === "manual", dependencies));
  });
  ctx.data.register("worker-health", async () => ({ status: "available" }));
  ctx.actions.register("get-status", async (_params, actionContext) => {
    const actor = actionContext.actor;
    const companyId = actionContext.companyId;
    if (actor.type !== "user" || !actor.userId || !companyId) return { status: "denied", errorCode: "user_context_required" };
    const state = (await ctx.state.get(stateScope(companyId)) ?? {}) as State;
    let config: BsmConfig = {};
    try { config = await ctx.config.get(companyId) as BsmConfig; } catch { /* treated as not configured */ }
    return buildStatus(config, state);
  });
}

const TICK_MS = 5 * 60_000;
const SUMMARY_KEYS = ["sourceCount", "created", "rotated", "nativeDriftCorrected", "metadataUpdated", "unchanged", "archived", "skippedArchived", "failed"] as const;

function sanitizeSummary(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of SUMMARY_KEYS) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    result[key] = value;
  }
  return result;
}

/** ADR-BSM-002 §3: booleans, codes, integers and ISO timestamps only. */
export function buildStatus(config: BsmConfig, state: State, nowMs = Date.now()) {
  const enabled = config.enabled === true;
  const configError = validateConfig(config, false);
  const configured = configError === null;
  const errorCode = state.errorCode ?? (configured ? null : configError);
  let nextEligibleAt: string | null = null;
  if (enabled && !(state.errorCode && AUTHORIZATION_BLOCKED.has(state.errorCode))) {
    const backoff = dateMillis(state.nextEligibleAt);
    const anchor = dateMillis(state.scheduledAnchor);
    const base = backoff ?? (anchor === null ? null : anchor + Math.max(5, Number(config.syncIntervalMinutes ?? 15)) * 60_000);
    if (base !== null) nextEligibleAt = new Date(Math.ceil(Math.max(base, nowMs) / TICK_MS) * TICK_MS).toISOString();
  }
  return {
    enabled, configured,
    status: configured ? state.status ?? "not_run" : "setup_needed",
    errorCode, warningCode: state.warningCode ?? null,
    lastAttemptAt: state.lastAttemptAt ?? null, lastSuccessAt: state.lastSuccessAt ?? null,
    nextEligibleAt, lastRunSummary: sanitizeSummary(state.lastRunSummary),
  };
}

function nativeTransport(ctx: PluginContext, origin: string, token: string): HttpTransport {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new AdapterError("invalid_input");
  }
  return async (request: HttpRequest): Promise<HttpResponse> => {
    if (!request.path.startsWith("/api/") || request.path.startsWith("//")) throw new AdapterError("invalid_input");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await ctx.http.fetch(`${base.origin}${request.path}`, {
        method: request.method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      return { status: response.status, headers: response.headers, json: async () => response.json() };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw error;
    } finally { clearTimeout(timeout); }
  };
}
